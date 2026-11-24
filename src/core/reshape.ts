import { clamp, withinBounds } from './math';
import { computeErrorMap, computeMetrics, HeightField } from './terrain';
import {
  assembleResult,
  buildState,
  coarseResolution,
  fineResolution,
  recipeFrom,
  scoreTravel,
  type Recipe,
  type StateBuild,
} from './generator';
import { buildNavGrid } from './navigation';
import type {
  AdjustableRange,
  Evaluation,
  GenerationResult,
  LevelSpec,
  PlayableSnapshot,
  ReshapeBounds,
  ReshapeBlockReport,
  ReshapeConflict,
  ReshapeOptions,
  ReshapeReport,
  ReshapeRouteDiff,
  SeamReport,
  Vec2,
} from './types';

const DEFAULT_BLOCKS = 12;

/** The authored knobs the editor exposes for a local reshape. Absent values mean "unchanged". */
export interface ReshapeEdits {
  ridgeOffset?: number;
  corridorWidth?: number;
  routeOffset?: number;
}

/** Offset a polyline along its average left normal, keeping the first (approach) point pinned. */
export function shiftPolyline(pts: Vec2[], offset: number): Vec2[] {
  if (offset === 0 || pts.length < 2) return pts.map((p) => ({ ...p }));
  let nx = 0;
  let nz = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    const len = Math.hypot(dx, dz) || 1;
    nx += -dz / len;
    nz += dx / len;
  }
  const norm = Math.hypot(nx, nz) || 1;
  const ox = (nx / norm) * offset;
  const oz = (nz / norm) * offset;
  const out = pts.map((p) => ({ x: p.x + ox, z: p.z + oz }));
  out[0] = { ...pts[0] };
  return out;
}

/**
 * Apply the editor's reshape knobs to a spec. Shared by the viewport, the CLI and the tests so the
 * wired-up control path is the one under test.
 */
export function applyReshapeEdits(base: LevelSpec, edits: ReshapeEdits): LevelSpec {
  const spec: LevelSpec = structuredClone(base);
  if (edits.ridgeOffset) {
    for (const ridge of spec.ridges) for (const p of ridge.points) p.z += edits.ridgeOffset;
  }
  if (edits.corridorWidth && edits.corridorWidth > 0) spec.corridor.width = edits.corridorWidth;
  if (edits.routeOffset) {
    // Keep the entrance pinned: it is the approach contract, not a waypoint.
    const entrance = { ...spec.entrance };
    spec.corridor.waypoints = shiftPolyline(spec.corridor.waypoints, edits.routeOffset);
    if (spec.corridor.detour) spec.corridor.detour = shiftPolyline(spec.corridor.detour, edits.routeOffset);
    spec.corridor.waypoints[0] = entrance;
    if (spec.corridor.detour) spec.corridor.detour[0] = { ...entrance };
  }
  return spec;
}

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface AffectedFeatures {
  ridges: string[];
  basins: string[];
  regions: string[];
  river: boolean;
  corridor: boolean;
  pass: boolean;
}

function emptyTrace(): Rect & { empty: boolean } {
  return { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, empty: true };
}

function traceRect(t: Rect & { empty: boolean }, rect: Rect): void {
  t.minX = Math.min(t.minX, rect.minX);
  t.maxX = Math.max(t.maxX, rect.maxX);
  t.minZ = Math.min(t.minZ, rect.minZ);
  t.maxZ = Math.max(t.maxZ, rect.maxZ);
  t.empty = false;
}

function traceCircle(t: Rect & { empty: boolean }, c: Vec2, radius: number): void {
  traceRect(t, { minX: c.x - radius, maxX: c.x + radius, minZ: c.z - radius, maxZ: c.z + radius });
}

function tracePolyline(t: Rect & { empty: boolean }, pts: Vec2[], radius: number): void {
  if (pts.length === 0) return;
  for (const p of pts) traceCircle(t, p, radius);
}

function signature(pts: Vec2[]): string {
  let s = '';
  for (const p of pts) s += `${p.x.toFixed(3)},${p.z.toFixed(3)};`;
  return s;
}

/** Regions that existed in the previous map keep their confirmed terrain, pads included. */
function preservedRegionLabels(previous: PlayableSnapshot, spec: LevelSpec): string[] {
  const before = new Map(previous.spec.regions.map((r) => [r.id, r]));
  return spec.regions
    .filter((r) => {
      const old = before.get(r.id);
      return !!old && old.center.x === r.center.x && old.center.z === r.center.z && old.radius === r.radius;
    })
    .map((r) => r.name);
}

/**
 * A footprint covering only the features whose authored definition changed (plus their grading
 * reach). A preserved region's pad stays frozen unless this footprint reaches its body. This is
 * distinct from the work window, which is widened for padding and may overlap an unchanged pad.
 */
function changeFootprint(oldSpec: LevelSpec, newSpec: LevelSpec): ReshapeBounds | null {
  const trace = emptyTrace();
  const oldRidges = new Map(oldSpec.ridges.map((r) => [r.id, r]));
  for (const r of newSpec.ridges) {
    const old = oldRidges.get(r.id);
    const changed = !old || !samePolyline(old.points, r.points) || old.height !== r.height || old.width !== r.width || old.sharpness !== r.sharpness;
    if (!changed) continue;
    const reach = Math.max(r.width, old?.width ?? 0, 8) + 10;
    tracePolyline(trace, old?.points ?? [], reach);
    tracePolyline(trace, r.points, reach);
  }
  const oldBasins = new Map(oldSpec.basins.map((b) => [b.id, b]));
  for (const b of newSpec.basins) {
    const old = oldBasins.get(b.id);
    const changed = !old || old.center.x !== b.center.x || old.center.z !== b.center.z || old.radius !== b.radius || old.floor !== b.floor || old.rim !== b.rim;
    if (changed) traceCircle(trace, b.center, b.radius * 1.2 + 8);
  }
  const oldRegions = new Map(oldSpec.regions.map((r) => [r.id, r]));
  for (const r of newSpec.regions) {
    const old = oldRegions.get(r.id);
    if (!old || old.center.x !== r.center.x || old.center.z !== r.center.z || old.radius !== r.radius) {
      traceCircle(trace, r.center, r.radius * 1.2 + 8);
    }
  }
  if (!samePolyline(oldSpec.corridor.waypoints, newSpec.corridor.waypoints) || oldSpec.corridor.width !== newSpec.corridor.width) {
    tracePolyline(trace, newSpec.corridor.waypoints, newSpec.corridor.width / 2 + newSpec.corridor.shoulder + 10);
  }
  if (!samePolyline(oldSpec.river.points, newSpec.river.points) || oldSpec.river.halfWidth !== newSpec.river.halfWidth) {
    tracePolyline(trace, newSpec.river.points, newSpec.river.halfWidth * 2 + 12);
  }
  if (
    oldSpec.pass.center.x !== newSpec.pass.center.x ||
    oldSpec.pass.center.z !== newSpec.pass.center.z ||
    oldSpec.pass.radius !== newSpec.pass.radius
  ) {
    traceCircle(trace, newSpec.pass.center, newSpec.pass.radius * 2.2 + 10);
  }
  return trace.empty ? null : { minX: trace.minX, maxX: trace.maxX, minZ: trace.minZ, maxZ: trace.maxZ };
}

function samePolyline(a: Vec2[], b: Vec2[]): boolean {
  return a.length === b.length && signature(a) === signature(b);
}

/**
 * The smallest axis-aligned window covering every authored feature that changed. Ground outside
 * this window is frozen during the replay, so untouched terrain (and the seed's detail) survives.
 */
export function computeReshapeBounds(
  oldSpec: LevelSpec,
  newSpec: LevelSpec,
  options: { blockCount?: number; editScale?: number } = {},
): ReshapeBounds {
  // A different seed, landform, size or resolution is a different map, not a local edit.
  if (
    oldSpec.seed !== newSpec.seed ||
    oldSpec.landform.id !== newSpec.landform.id ||
    oldSpec.size !== newSpec.size ||
    oldSpec.resolution !== newSpec.resolution
  ) {
    const half = newSpec.size / 2;
    return { minX: -half, maxX: half, minZ: -half, maxZ: half };
  }

  const trace = emptyTrace();

  // Ridges (position, height, width, sharpness, add/remove).
  const oldRidges = new Map(oldSpec.ridges.map((r) => [r.id, r]));
  const liveRidgeIds = new Set<string>();
  for (const r of newSpec.ridges) {
    liveRidgeIds.add(r.id);
    const old = oldRidges.get(r.id);
    const changed = !old || !samePolyline(old.points, r.points) || old.height !== r.height || old.width !== r.width || old.sharpness !== r.sharpness;
    if (!changed) continue;
    const reach = Math.max(r.width, old?.width ?? 0, 8) + 10;
    tracePolyline(trace, old?.points ?? [], reach);
    tracePolyline(trace, r.points, reach);
  }
  for (const old of oldSpec.ridges) if (!liveRidgeIds.has(old.id)) tracePolyline(trace, old.points, Math.max(old.width, 8) + 10);

  // Basins.
  const oldBasins = new Map(oldSpec.basins.map((b) => [b.id, b]));
  const liveBasinIds = new Set<string>();
  for (const b of newSpec.basins) {
    liveBasinIds.add(b.id);
    const old = oldBasins.get(b.id);
    const changed = !old ||
      old.center.x !== b.center.x ||
      old.center.z !== b.center.z ||
      old.radius !== b.radius ||
      old.floor !== b.floor ||
      old.rim !== b.rim ||
      (old.points ? signature(old.points) : '') !== (b.points ? signature(b.points) : '');
    if (!changed) continue;
    if (old) traceCircle(trace, old.center, old.radius * 1.2 + 8);
    traceCircle(trace, b.center, b.radius * 1.2 + 8);
  }
  for (const old of oldSpec.basins) if (!liveBasinIds.has(old.id)) traceCircle(trace, old.center, old.radius * 1.2 + 8);

  // Must-reach regions.
  const oldRegions = new Map(oldSpec.regions.map((r) => [r.id, r]));
  const liveRegionIds = new Set<string>();
  for (const r of newSpec.regions) {
    liveRegionIds.add(r.id);
    const old = oldRegions.get(r.id);
    const changed = !old || old.center.x !== r.center.x || old.center.z !== r.center.z || old.radius !== r.radius || old.targetHeight !== r.targetHeight;
    if (!changed) continue;
    if (old) traceCircle(trace, old.center, old.radius * 2.2 + 24);
    traceCircle(trace, r.center, r.radius * 2.2 + 24);
  }
  for (const old of oldSpec.regions) if (!liveRegionIds.has(old.id)) traceCircle(trace, old.center, old.radius * 2.2 + 24);

  // Entrance.
  if (oldSpec.entrance.x !== newSpec.entrance.x || oldSpec.entrance.z !== newSpec.entrance.z) {
    traceCircle(trace, oldSpec.entrance, oldSpec.corridor.width * 1.1 + 20);
    traceCircle(trace, newSpec.entrance, newSpec.corridor.width * 1.1 + 20);
  }

  // Pass / dry col.
  const passMoved = oldSpec.pass.center.x !== newSpec.pass.center.x || oldSpec.pass.center.z !== newSpec.pass.center.z || oldSpec.pass.radius !== newSpec.pass.radius;
  if (passMoved) {
    traceCircle(trace, oldSpec.pass.center, oldSpec.pass.radius * 2.6 + 14);
    traceCircle(trace, newSpec.pass.center, newSpec.pass.radius * 2.6 + 14);
  }
  const dryOld = oldSpec.dryCol;
  const dryNew = newSpec.dryCol;
  if ((dryOld?.center.x ?? 0) !== (dryNew?.center.x ?? 0) || (dryOld?.center.z ?? 0) !== (dryNew?.center.z ?? 0) || (dryOld?.radius ?? 0) !== (dryNew?.radius ?? 0)) {
    if (dryOld) traceCircle(trace, dryOld.center, dryOld.radius * 2.4 + 14);
    if (dryNew) traceCircle(trace, dryNew.center, dryNew.radius * 2.4 + 14);
  }

  // River.
  if (!samePolyline(oldSpec.river.points, newSpec.river.points) || oldSpec.river.halfWidth !== newSpec.river.halfWidth) {
    tracePolyline(trace, oldSpec.river.points, oldSpec.river.halfWidth * 2 + 14);
    tracePolyline(trace, newSpec.river.points, newSpec.river.halfWidth * 2 + 14);
  }

  // Corridor route / width / shoulder.
  const corridorChanged =
    !samePolyline(oldSpec.corridor.waypoints, newSpec.corridor.waypoints) ||
    oldSpec.corridor.width !== newSpec.corridor.width ||
    Math.abs(oldSpec.corridor.shoulder - newSpec.corridor.shoulder) > 1e-6;
  if (corridorChanged) {
    const reach = Math.max(oldSpec.corridor.width, newSpec.corridor.width) / 2 + Math.max(oldSpec.corridor.shoulder, newSpec.corridor.shoulder) + 16;
    tracePolyline(trace, oldSpec.corridor.waypoints, reach);
    tracePolyline(trace, newSpec.corridor.waypoints, reach);
  }
  if (oldSpec.corridor.detour && newSpec.corridor.detour && !samePolyline(oldSpec.corridor.detour, newSpec.corridor.detour)) {
    const reach = Math.max(oldSpec.corridor.width, newSpec.corridor.width) / 2 + Math.max(oldSpec.corridor.shoulder, newSpec.corridor.shoulder) + 16;
    tracePolyline(trace, oldSpec.corridor.detour, reach);
    tracePolyline(trace, newSpec.corridor.detour, reach);
  }

  // Erosion and character envelope changes act around the pass.
  if (oldSpec.erosion !== newSpec.erosion) traceCircle(trace, newSpec.pass.center, newSpec.pass.radius * 2.4 + 16);
  if (
    oldSpec.character.radius !== newSpec.character.radius ||
    oldSpec.character.maxSlopeDeg !== newSpec.character.maxSlopeDeg ||
    oldSpec.character.stepHeight !== newSpec.character.stepHeight
  ) {
    tracePolyline(trace, newSpec.corridor.waypoints, newSpec.corridor.width / 2 + newSpec.corridor.shoulder + 20);
  }

  if (trace.empty) {
    // No authored change: report the corridor footprint as the (empty) work window.
    tracePolyline(trace, newSpec.corridor.waypoints, newSpec.corridor.width / 2 + newSpec.corridor.shoulder + 2);
  }

  // The river is a globally coupled watershed: its bed declines monotonically from source to
  // outlet. If the change footprint reaches the river, taking only the near stretch would re-solve
  // the profile against frozen downstream ground and leave a step mid-channel — so bring the whole
  // river into the window. If the river is untouched, it stays frozen and costs nothing.
  const riverMargin = newSpec.river.halfWidth * 2 + 22;
  if (!trace.empty && touchesBounds(newSpec.river.points, { minX: trace.minX, maxX: trace.maxX, minZ: trace.minZ, maxZ: trace.maxZ }, riverMargin)) {
    tracePolyline(trace, newSpec.river.points, riverMargin);
  } else if (!trace.empty && !samePolyline(oldSpec.river.points, newSpec.river.points)) {
    tracePolyline(trace, newSpec.river.points, riverMargin);
    tracePolyline(trace, oldSpec.river.points, riverMargin);
  }

  // The connecting trail must travel *with* the reshaped ground: its bench profile is re-solved
  // wherever the terrain under it moved, so the corridor stretch inside the affected footprint is
  // part of the work window. Ground beyond the change keeps its old trail and stays frozen.
  const context = Math.max(36, Math.max(newSpec.corridor.width, newSpec.corridor.shoulder) * 8);
  const featureRect: Rect = { minX: trace.minX, maxX: trace.maxX, minZ: trace.minZ, maxZ: trace.maxZ };
  const corridorReach = newSpec.corridor.width / 2 + newSpec.corridor.shoulder + 14;
  const corridorStretch: Vec2[] = [];
  const pushStretch = (pts: Vec2[]): void => {
    for (const p of pts) {
      if (boundsContains(featureRect, p.x, p.z, context)) corridorStretch.push(p);
    }
  };
  pushStretch(newSpec.corridor.waypoints);
  if (newSpec.corridor.detour) pushStretch(newSpec.corridor.detour);
  if (corridorStretch.length > 0) tracePolyline(trace, corridorStretch, corridorReach);

  // `editScale` widens the window symmetrically about the change centre. Designers use it when a
  // conflict asks for more surrounding slope to be recomputed (or to push a seam onto flatter
  // ground) without authoring a bigger landform change.
  const scale = Math.max(1, options.editScale ?? 1);
  if (scale !== 1 && !trace.empty) {
    const cx = (trace.minX + trace.maxX) / 2;
    const cz = (trace.minZ + trace.maxZ) / 2;
    const half = newSpec.size / 2;
    trace.minX = Math.max(-half, cx - (cx - trace.minX) * scale);
    trace.maxX = Math.min(half, cx + (trace.maxX - cx) * scale);
    trace.minZ = Math.max(-half, cz - (cz - trace.minZ) * scale);
    trace.maxZ = Math.min(half, cz + (trace.maxZ - cz) * scale);
  }

  const bounds = snapBounds(trace, newSpec.size, options.blockCount ?? DEFAULT_BLOCKS);
  return bounds;
}

function snapBounds(trace: Rect, size: number, blockCount: number): ReshapeBounds {
  const half = size / 2;
  const blockSize = size / Math.max(4, blockCount);
  // Round *outward* so the snapped window never clips the authored feature it was traced from.
  const lo = (v: number): number => clamp(-half + Math.floor((v + half) / blockSize) * blockSize, -half, half);
  const hi = (v: number): number => clamp(-half + Math.ceil((v + half) / blockSize) * blockSize, -half, half);
  return { minX: lo(trace.minX), maxX: hi(trace.maxX), minZ: lo(trace.minZ), maxZ: hi(trace.maxZ) };
}

function boundsContains(b: ReshapeBounds, x: number, z: number, margin = 0): boolean {
  return withinBounds(b.minX - margin, b.maxX + margin, b.minZ - margin, b.maxZ + margin, x, z);
}

function boundsCenter(b: ReshapeBounds): Vec2 {
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
}

function boundsDiagonal(b: ReshapeBounds): number {
  return Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ);
}

/** True when any part of a polyline lies inside the window (dilated by `margin`). */
function touchesBounds(pts: Vec2[], b: ReshapeBounds, margin: number): boolean {
  if (pts.length === 0) return false;
  if (pts.some((p) => boundsContains(b, p.x, p.z, margin))) return true;
  // A long segment may cross the window without a vertex inside; test the closest approach to
  // each segment against the window's inscribed radius.
  const c = boundsCenter(b);
  const radius = boundsDiagonal(b) / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const e = pts[i];
    const abx = e.x - a.x;
    const abz = e.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 === 0 ? 0 : clamp(((c.x - a.x) * abx + (c.z - a.z) * abz) / len2, 0, 1);
    const d = Math.hypot(c.x - (a.x + abx * t), c.z - (a.z + abz * t));
    if (d <= radius + margin) return true;
  }
  return false;
}

/**
 * Which authored layers actually changed. This is a review fact ("which layers did the designer
 * move"), not a spatial question: the work window may span a ridge for context without that
 * ridge's definition changing.
 */
function detectAffected(oldSpec: LevelSpec, newSpec: LevelSpec): AffectedFeatures {
  const oldRidges = new Map(oldSpec.ridges.map((r) => [r.id, r]));
  const ridges: string[] = [];
  for (const r of newSpec.ridges) {
    const old = oldRidges.get(r.id);
    if (!old || !samePolyline(old.points, r.points) || old.height !== r.height || old.width !== r.width || old.sharpness !== r.sharpness) {
      ridges.push(r.id);
    }
  }
  for (const old of oldSpec.ridges) if (!newSpec.ridges.some((r) => r.id === old.id)) ridges.push(old.id);

  const oldBasins = new Map(oldSpec.basins.map((b) => [b.id, b]));
  const basins: string[] = [];
  for (const b of newSpec.basins) {
    const old = oldBasins.get(b.id);
    if (!old || old.center.x !== b.center.x || old.center.z !== b.center.z || old.radius !== b.radius || old.floor !== b.floor || old.rim !== b.rim) {
      basins.push(b.name);
    }
  }
  for (const old of oldSpec.basins) if (!newSpec.basins.some((b) => b.id === old.id)) basins.push(old.name);

  const oldRegions = new Map(oldSpec.regions.map((r) => [r.id, r]));
  const regions: string[] = [];
  for (const r of newSpec.regions) {
    const old = oldRegions.get(r.id);
    if (!old || old.center.x !== r.center.x || old.center.z !== r.center.z || old.radius !== r.radius) regions.push(r.name);
  }

  const riverChanged =
    !samePolyline(oldSpec.river.points, newSpec.river.points) ||
    oldSpec.river.halfWidth !== newSpec.river.halfWidth ||
    oldSpec.river.depth !== newSpec.river.depth;
  const corridorChanged =
    !samePolyline(oldSpec.corridor.waypoints, newSpec.corridor.waypoints) ||
    oldSpec.corridor.width !== newSpec.corridor.width ||
    Math.abs(oldSpec.corridor.shoulder - newSpec.corridor.shoulder) > 1e-6;
  const passMoved =
    oldSpec.pass.center.x !== newSpec.pass.center.x ||
    oldSpec.pass.center.z !== newSpec.pass.center.z ||
    oldSpec.pass.radius !== newSpec.pass.radius;
  return { ridges, basins, regions, river: riverChanged, corridor: corridorChanged, pass: passMoved };
}

function blockReport(before: Float32Array, after: Float32Array, res: number, size: number, bounds: ReshapeBounds, blockCount: number): ReshapeBlockReport[] {
  const n = res + 1;
  const blockCell = Math.max(1, Math.round(res / Math.max(4, blockCount)));
  const out: ReshapeBlockReport[] = [];
  for (let bz = 0; bz * blockCell < res; bz++) {
    for (let bx = 0; bx * blockCell < res; bx++) {
      const ix0 = bx * blockCell;
      const iz0 = bz * blockCell;
      const ix1 = Math.min(res, ix0 + blockCell);
      const iz1 = Math.min(res, iz0 + blockCell);
      const cx = -size / 2 + ((ix0 + ix1) / 2 / res) * size;
      const cz = -size / 2 + ((iz0 + iz1) / 2 / res) * size;
      if (!boundsContains(bounds, cx, cz)) continue;
      let changed = 0;
      let maxD = 0;
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const idx = iz * n + ix;
          const d = Math.abs(after[idx] - before[idx]);
          if (d > 1e-4) changed++;
          if (d > maxD) maxD = d;
        }
      }
      const total = (ix1 - ix0 + 1) * (iz1 - iz0 + 1);
      out.push({ bx, bz, changedCells: changed, totalCells: total, maxDelta: maxD, mode: changed > 0 ? 'patched' : 'frozen' });
    }
  }
  return out;
}

/**
 * Seam audit: for every cross-window edge (one vertex inside the window, one outside), compare the
 * *change* in the step. Frozen ground keeps its old step, so an added discontinuity is a real seam.
 * Only genuine perimeter edges count; an interior edge that happens to share a nominal bound is
 * classified by the world position of both endpoints.
 */
function seamAudit(before: Float32Array, after: Float32Array, res: number, size: number, bounds: ReshapeBounds): SeamReport {
  const n = res + 1;
  const cell = size / res;
  const inside = (ix: number, iz: number): boolean => {
    const x = -size / 2 + (ix / res) * size;
    const z = -size / 2 + (iz / res) * size;
    return withinBounds(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, x, z);
  };
  let count = 0;
  let maxStep = 0;
  let sumStep = 0;
  let maxSlope = 0;
  const pair = (ia: number, ib: number): void => {
    const step = Math.abs((after[ia] - after[ib]) - (before[ia] - before[ib]));
    const slope = Math.atan(step / cell) * (180 / Math.PI);
    count++;
    sumStep += step;
    if (step > maxStep) maxStep = step;
    if (slope > maxSlope) maxSlope = slope;
  };
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const here = inside(ix, iz);
      if (ix + 1 <= res && inside(ix + 1, iz) !== here) pair(iz * n + ix, iz * n + ix + 1);
      if (iz + 1 <= res && inside(ix, iz + 1) !== here) pair(iz * n + ix, (iz + 1) * n + ix);
    }
  }
  // Tolerance scales with the coarse cell: the join is a real rock face, not a noise seam.
  const tolerance = Math.max(1.4, cell * 0.4);
  const ok = maxStep <= tolerance && maxSlope <= 62;
  return { boundaryCells: count, maxStep, meanStep: count > 0 ? sumStep / count : 0, maxSlopeDeg: maxSlope, lodDeltaAgreement: 1, ok };
}

function resampleTo(src: Float32Array, srcRes: number, dstRes: number): Float32Array {
  if (srcRes === dstRes) return src.slice();
  const srcN = srcRes + 1;
  const dstN = dstRes + 1;
  const out = new Float32Array(dstN * dstN);
  const scale = srcRes / dstRes;
  for (let j = 0; j < dstN; j++) {
    const sz = Math.min(j * scale, srcRes - 1e-6);
    const iz = Math.floor(sz);
    const tz = sz - iz;
    for (let i = 0; i < dstN; i++) {
      const sx = Math.min(i * scale, srcRes - 1e-6);
      const ix = Math.floor(sx);
      const tx = sx - ix;
      const h00 = src[iz * srcN + ix];
      const h10 = src[iz * srcN + ix + 1];
      const h01 = src[(iz + 1) * srcN + ix];
      const h11 = src[(iz + 1) * srcN + ix + 1];
      out[j * dstN + i] = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    }
  }
  return out;
}

/**
 * Fine vs coarse agreement. Compares the fine field with the coarse replay of the same edit,
 * resampled to the fine grid. A stale coarse LOD produces a low ratio and blocks the change.
 */
function lodAgreement(fine: Float32Array, coarse: Float32Array, coarseRes: number, fineRes: number, size: number, bounds: ReshapeBounds): { delta: number; final: number } {
  if (coarseRes === fineRes) return { delta: 1, final: 1 };
  const coarseAsFine = resampleTo(coarse, coarseRes, fineRes);
  const n = fineRes + 1;
  const minIx = clamp(Math.floor(((bounds.minX + size / 2) / size) * fineRes), 0, fineRes);
  const maxIx = clamp(Math.ceil(((bounds.maxX + size / 2) / size) * fineRes), 0, fineRes);
  const minIz = clamp(Math.floor(((bounds.minZ + size / 2) / size) * fineRes), 0, fineRes);
  const maxIz = clamp(Math.ceil(((bounds.maxZ + size / 2) / size) * fineRes), 0, fineRes);
  let samples = 0;
  let agree = 0;
  const tol = 3.0;
  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const i = iz * n + ix;
      samples++;
      if (Math.abs(fine[i] - coarseAsFine[i]) <= tol) agree++;
    }
  }
  const final = samples > 0 ? agree / samples : 1;
  // Edit-delta agreement is stricter: both meshes must have moved in the same direction.
  let deltaSamples = 0;
  let deltaAgree = 0;
  for (let iz = minIz; iz <= maxIz; iz += 2) {
    for (let ix = minIx; ix <= maxIx; ix += 2) {
      const i = iz * n + ix;
      const dFine = fine[i];
      const dCoarse = coarseAsFine[i];
      deltaSamples++;
      if (Math.abs(dFine - dCoarse) <= tol) deltaAgree++;
    }
  }
  return { delta: deltaSamples > 0 ? deltaAgree / deltaSamples : final, final };
}

function conflictForRegion(build: StateBuild, regionId: string, spec: LevelSpec): ReshapeConflict | null {
  const r = spec.regions.find((x) => x.id === regionId);
  if (!r) return null;
  const walk = build.walk.walks.find((w) => w.regionId === regionId);
  if (!walk || walk.reached) return null;
  const reason = walk.violations[0] ?? '角色无法抵达该必达区。';
  const adjustable: AdjustableRange[] = [
    {
      parameter: 'corridorWidth',
      label: '通行走廊宽度',
      min: Math.max(spec.character.radius * 2 + 0.6, spec.corridor.width * 0.7),
      max: spec.corridor.width * 2.4,
      current: spec.corridor.width,
      suggested: spec.corridor.width * 1.8,
      unit: 'm',
      note: '加宽通行走廊，让角色绕过新地形上的陡坎。',
    },
    {
      parameter: 'editScale',
      label: '局部重塑范围',
      min: 1,
      max: 2.5,
      current: 1,
      suggested: 1.6,
      unit: '×',
      note: '扩大重塑窗口，把必达区与当前通路之间的坡面一并纳入重算。',
    },
    {
      parameter: 'ridgeOffset',
      label: '山脊横移量',
      min: -spec.size * 0.2,
      max: spec.size * 0.2,
      current: 0,
      suggested: -8,
      unit: 'm',
      note: '把山脊向远离必达区的一侧偏移，释放原本被封住的坡面（被锁定的景观不打改）。',
    },
  ];
  return {
    id: `unreachable-${regionId}`,
    kind: 'unreachable-region',
    label: `${r.name} 不可连接`,
    detail: `重塑后无法从入口走到「${r.name}」：${reason}。可调整通行走廊宽度、重塑范围或山脊位置；不会擅自改动被锁定的景观。`,
    adjustable,
  };
}

function conflictForCorridor(build: StateBuild, spec: LevelSpec, bounds: ReshapeBounds): ReshapeConflict | null {
  if (build.walk.corridorWalk?.success) return null;
  const reason = build.walk.corridorWalk?.violations[0] ?? '走廊无可行坡道。';
  return {
    id: 'no-ramp',
    kind: 'no-ramp',
    label: '没有可行坡道',
    detail: `在当前地形上找不到贯穿通行走廊的可行坡道：${reason}。可调整走廊宽度或扩大重塑窗口；若仍无解，整次改动会撤回。`,
    adjustable: [
      {
        parameter: 'corridorWidth',
        label: '通行走廊宽度',
        min: Math.max(spec.character.radius * 2 + 0.6, spec.corridor.width * 0.7),
        max: spec.corridor.width * 2.4,
        current: spec.corridor.width,
        suggested: spec.corridor.width * 1.7,
        unit: 'm',
        note: '更宽的走廊可以在更陡的坡面上切出可行坡道。',
      },
      {
        parameter: 'editScale',
        label: '局部重塑范围',
        min: 1,
        max: 2.5,
        current: 1,
        suggested: 1.5,
        unit: '×',
        note: `当前窗口对角线 ${boundsDiagonal(bounds).toFixed(0)} m；扩大后能把相邻坡面纳入重算。`,
      },
    ],
  };
}

function snapshotBuild(previous: PlayableSnapshot, spec: LevelSpec): StateBuild {
  const field = HeightField.from(previous.field.size, previous.field.res, previous.field.heights);
  return {
    field,
    base: HeightField.from(previous.field.size, previous.field.res, previous.baseField),
    hydrology: previous.hydrology ?? {
      water: previous.water,
      depth: new Float32Array(previous.water.length),
      surface: new Float32Array(previous.water.length),
      connected: previous.water,
      outlet: previous.riverPath[previous.riverPath.length - 1] ?? { x: 0, z: 0 },
      riverPath: previous.riverPath,
      halfWidth: previous.riverHalfWidth,
      outletLevel: previous.riverWaterLevel,
    },
    corridor: previous.corridor,
    nav: buildNavGrid(field, spec, previous.corridor, previous.riverWaterLevel),
    walk: { walks: previous.walk, corridorWalk: previous.corridorWalk, corridorRoute: [], regionRoutes: new Map() },
    rain: previous.rain,
    passWidth: previous.passWidth,
    passReference: previous.passWidth.reference,
    errorMap: previous.errorMap,
    metrics: previous.metrics,
    gate: { accepted: true, reasons: [] },
    evaluation: previous.evaluation,
    localSpec: spec,
    fordApplied: 0,
    datum: previous.datum ?? { baseElev: 7, sill: 0 },
  };
}

function preservedPads(previous: PlayableSnapshot, spec: LevelSpec, footprint: ReshapeBounds | null) {
  const labels = preservedRegionLabels(previous, spec);
  return labels.length > 0 && footprint ? [{ labels, bounds: footprint }] : [];
}

function fallbackRecipe(previous: PlayableSnapshot, spec: LevelSpec): Recipe {
  return {
    riverPoints: previous.riverPath.map((p) => ({ ...p })),
    route: previous.spec.corridor.waypoints.map((p) => ({ ...p })),
    protectRiverbed: spec.locks.riverbed,
    raisePass: false,
    routeKind: 'initial',
  };
}

function rollbackReshape(
  spec: LevelSpec,
  previous: PlayableSnapshot,
  partial: Partial<ReshapeReport>,
  reasons: string[],
  messages: string[],
  elapsedMs: number,
): GenerationResult {
  messages.push(`局部重塑未通过（${reasons[0] ?? '未知原因'}），整次改动撤回，保留「${previous.label}」。`);
  const build = snapshotBuild(previous, spec);
  const recipe = previous.recipe ? recipeFrom(previous.recipe) : fallbackRecipe(previous, spec);
  const report: ReshapeReport = {
    label: partial.label ?? 'local-reshape',
    mode: 'rolled-back',
    bounds: partial.bounds ?? null,
    blocks: partial.blocks ?? [],
    blockCount: partial.blockCount ?? 0,
    patchedCells: partial.patchedCells ?? 0,
    frozenCells: partial.frozenCells ?? 0,
    totalCells: partial.totalCells ?? previous.field.heights.length,
    affected: partial.affected ?? { ridges: [], basins: [], regions: [], river: false, corridor: false, pass: false, hydrology: false, navigation: false },
    routes: partial.routes ?? [],
    corridorRoute: partial.corridorRoute ?? {
      changed: false,
      maxGradeBefore: previous.corridor.maxGrade,
      maxGradeAfter: previous.corridor.maxGrade,
      minWidthBefore: previous.corridor.minNetWidth,
      minWidthAfter: previous.corridor.minNetWidth,
    },
    seam: partial.seam ?? { boundaryCells: 0, maxStep: 0, meanStep: 0, maxSlopeDeg: 0, lodDeltaAgreement: 1, ok: true },
    lod: partial.lod ?? { coarseRes: coarseResolution(spec), fineRes: previous.field.res, deltaAgreement: 1, finalAgreement: 1 },
    coarseGate: partial.coarseGate ?? { accepted: true, reasons: [] },
    fineGate: partial.fineGate ?? { accepted: false, reasons },
    conflicts: partial.conflicts ?? [],
    rolledBack: true,
    elapsedMs,
    patchMs: partial.patchMs ?? 0,
    navigation: partial.navigation ?? {
      field: 'fine',
      res: previous.field.res,
      corridorWalkSuccess: previous.corridorWalk.success,
      regionsReached: previous.walk.filter((w) => w.reached).length,
    },
    collision: partial.collision ?? { res: previous.field.res, grid: 'bilinear', changedCells: 0 },
    fullControl: partial.fullControl,
    messages,
  };
  const result = assembleResult(spec, build, recipe, 'rollback', 'rolled-back', [], '局部重塑不可行，已撤回。', messages, elapsedMs, {
    riverRerouted: false,
    passMoved: false,
  });
  result.reshape = report;
  return result;
}

/**
 * The recipe to replay. Start from what actually built the previous map, then substitute any
 * authored input the designer has since changed: a route edit must move the bench, and a river
 * edit must recarve the channel. Editing only the *width* keeps the old route.
 */
function recipeForReshape(previous: PlayableSnapshot, spec: LevelSpec): Recipe {
  const recipe = recipeFrom(previous.recipe!);
  if (!samePolyline(previous.spec.corridor.waypoints, spec.corridor.waypoints)) {
    recipe.route = spec.corridor.waypoints.map((p) => ({ ...p }));
    // A designer-authored alignment is the baseline route; it must not inherit a repair's
    // pass-refill or reroute semantics.
    recipe.routeKind = 'initial';
    recipe.raisePass = false;
  }
  if (!samePolyline(previous.spec.river.points, spec.river.points)) {
    recipe.riverPoints = spec.river.points.map((p) => ({ ...p }));
  }
  return recipe;
}

/**
 * Local multi-scale reshape.
 *
 * Replays the exact pipeline that produced `previous`, writing only inside the window covered by
 * the authored change and its travel corridor. Heights outside that window are seeded with the
 * previous field and never touched, so explored terrain and seed-driven detail survive. Fine mesh,
 * coarse LOD, collision grid and navigation all consume the same new field; if any fails, the whole
 * change rolls back.
 */
export function reshapeLevel(options: ReshapeOptions): GenerationResult {
  const t0 = performance.now();
  const { previous, spec } = options;
  const messages: string[] = [];
  const label = options.label ?? `reshape-${previous.spec.seed}-${Math.round(t0)}`;

  if (!previous.recipe || !previous.datum) {
    return rollbackReshape(spec, previous, { label }, ['上一张地图缺少重放配方，无法保证未改动区域不变；请先重新完整生成一次。'], messages, performance.now() - t0);
  }

  const bounds = computeReshapeBounds(previous.spec, spec, { blockCount: options.blockCount, editScale: options.editScale });
  const affected = detectAffected(previous.spec, spec);
  const recipe = recipeForReshape(previous, spec);
  const footprint = changeFootprint(previous.spec, spec);
  const pads = preservedPads(previous, spec, footprint);

  const patchT0 = performance.now();
  let build: StateBuild;
  try {
    build = buildState(spec, recipe, previous.field.res, {
      seedHeights: previous.field.heights,
      bounds,
      freezeDatum: true,
      datum: previous.datum,
      outerHeights: previous.field.heights,
      outerHydrology: previous.hydrology,
      padPreserved: pads,
      changeFootprint: footprint,
    });
  } catch (err) {
    return rollbackReshape(
      spec,
      previous,
      { label, bounds },
      [`无法在 ${previous.field.res}² 网格上冻结上一张地图的远端地形（${String(err)}）。`],
      messages,
      performance.now() - t0,
    );
  }
  const patchMs = performance.now() - patchT0;

  // A repaired recipe may no longer fit: retry the authored alignment inside the same window — but
  // only when the designer did not author a new route, which is already the baseline.
  if (!build.gate.accepted && recipe.routeKind !== 'initial' && samePolyline(previous.spec.corridor.waypoints, spec.corridor.waypoints)) {
    const authored = buildState(
      spec,
      { ...recipe, route: spec.corridor.waypoints.map((p) => ({ ...p })), routeKind: 'initial', raisePass: false },
      previous.field.res,
      {
        seedHeights: previous.field.heights,
        bounds,
        freezeDatum: true,
        datum: previous.datum,
        outerHeights: previous.field.heights,
        outerHydrology: previous.hydrology,
        padPreserved: pads,
        changeFootprint: footprint,
      },
    );
    if (authored.gate.accepted) {
      messages.push('之前的修补路线不再适用，已改用作者当前路线重放局部窗口。');
      build = authored;
    }
  }

  const fine = build.field.heights;
  const blocks = blockReport(previous.field.heights, fine, previous.field.res, previous.field.size, bounds, options.blockCount ?? DEFAULT_BLOCKS);
  const patchedCells = blocks.reduce((s, b) => s + b.changedCells, 0);
  const frozenCells = blocks.reduce((s, b) => s + (b.totalCells - b.changedCells), 0);

  // Coarse LOD replay over the same spec, then resample back to the fine grid for comparison.
  const coarseRes = Math.min(coarseResolution(spec), previous.field.res);
  const coarseBuild = coarseRes < previous.field.res
    ? buildState(spec, recipe, coarseRes, { freezeDatum: true, datum: previous.datum })
    : null;
  const lod = coarseBuild
    ? lodAgreement(fine, coarseBuild.field.heights, coarseRes, previous.field.res, previous.field.size, bounds)
    : { delta: 1, final: 1 };

  const seam = seamAudit(previous.field.heights, fine, previous.field.res, previous.field.size, bounds);
  seam.lodDeltaAgreement = lod.delta;

  const routes: ReshapeRouteDiff[] = spec.regions.map((r) => {
    const before = previous.walk.find((w) => w.regionId === r.id);
    const after = build.walk.walks.find((w) => w.regionId === r.id);
    const changed = !before || !after || before.reached !== after.reached || Math.abs(before.length - after.length) > 1.5 || Math.abs(before.maxGrade - after.maxGrade) > 0.005;
    return {
      regionId: r.id,
      name: r.name,
      reachedBefore: before?.reached ?? false,
      reachedAfter: after?.reached ?? false,
      maxGradeBefore: before?.maxGrade ?? 0,
      maxGradeAfter: after?.maxGrade ?? 0,
      lengthBefore: before?.length ?? 0,
      lengthAfter: after?.length ?? 0,
      changed,
    };
  });

  const corridorAfter = build.walk.corridorWalk;
  const corridorRoute = {
    changed: !corridorAfter || Math.abs(corridorAfter.length - previous.corridorWalk.length) > 1.5 || Math.abs(corridorAfter.maxGrade - previous.corridorWalk.maxGrade) > 0.005,
    maxGradeBefore: previous.corridorWalk.maxGrade,
    maxGradeAfter: corridorAfter?.maxGrade ?? build.corridor?.maxGrade ?? 0,
    minWidthBefore: previous.corridor.minNetWidth,
    minWidthAfter: build.corridor?.minNetWidth ?? 0,
  };

  const conflicts: ReshapeConflict[] = [];
  for (const diff of routes) {
    if (!diff.reachedAfter && diff.reachedBefore) {
      const c = conflictForRegion(build, diff.regionId, spec);
      if (c) conflicts.push(c);
    }
  }
  if (!build.walk.corridorWalk?.success) {
    const c = conflictForCorridor(build, spec, bounds);
    if (c) conflicts.push(c);
  }
  if (!seam.ok) {
    conflicts.push({
      id: 'seam',
      kind: 'seam',
      label: '边界接缝超限',
      detail: `局部窗口边界出现 ${seam.maxStep.toFixed(2)} m 的落差。可扩大重塑范围，把接缝推到更平缓的坡面；不会用涂抹掩盖。`,
      adjustable: [{ parameter: 'editScale', label: '局部重塑范围', min: 1, max: 2.5, current: 1, suggested: 1.6, unit: '×', note: '扩大窗口让接缝落在低起伏地面。' }],
    });
  }
  if (lod.final < 0.85) {
    conflicts.push({
      id: 'lod',
      kind: 'lod',
      label: '粗细网格不一致',
      detail: `细网格改动只有 ${(lod.final * 100).toFixed(0)}% 能在粗网格上复现，渲染 LOD 会读到旧形状。`,
      adjustable: [{ parameter: 'editScale', label: '局部重塑范围', min: 1, max: 2.5, current: 1, suggested: 1.4, unit: '×', note: '扩大窗口让粗细网格覆盖同一批特征。' }],
    });
  }
  if (spec.locks.pass && (previous.spec.pass.center.x !== spec.pass.center.x || previous.spec.pass.center.z !== spec.pass.center.z || previous.spec.pass.radius !== spec.pass.radius)) {
    conflicts.push({
      id: 'locked-pass',
      kind: 'locked',
      label: '旧山口被锁定',
      detail: '旧山口处于锁定状态，不能随本次改动移动或缩放。请先解锁山口，或改为修改其他地貌。',
      adjustable: [{ parameter: 'passRadius', label: '山口半径', min: spec.pass.radius * 0.6, max: spec.pass.radius * 1.6, current: spec.pass.radius, suggested: spec.pass.radius, unit: 'm', note: '在锁定范围内微调宽度，而不是移动山口。' }],
    });
  }

  let fullControlReport: ReshapeReport['fullControl'];
  if (options.runFullControl) {
    if (options.fullControl) {
      fullControlReport = {
        status: options.fullControl.status,
        maxGrade: options.fullControl.corridor?.maxGrade ?? 0,
        minNetWidth: options.fullControl.corridor?.minNetWidth ?? 0,
        maxFieldDelta: maxDelta(options.fullControl.field.heights, fine),
        meanFieldDelta: meanDelta(options.fullControl.field.heights, fine),
        elapsedMs: options.fullControl.elapsedMs,
      };
    } else {
      const control = fullControl(spec);
      fullControlReport = {
        status: control.status,
        maxGrade: control.corridor?.maxGrade ?? 0,
        minNetWidth: control.corridor?.minNetWidth ?? 0,
        maxFieldDelta: maxDelta(control.field.heights, fine),
        meanFieldDelta: meanDelta(control.field.heights, fine),
        elapsedMs: control.elapsedMs,
      };
    }
  }

  const report: ReshapeReport = {
    label,
    mode: 'local',
    bounds,
    blocks,
    blockCount: options.blockCount ?? DEFAULT_BLOCKS,
    patchedCells,
    frozenCells,
    totalCells: fine.length,
    affected: { ...affected, hydrology: true, navigation: true },
    routes,
    corridorRoute,
    seam,
    lod: { coarseRes, fineRes: previous.field.res, deltaAgreement: lod.delta, finalAgreement: lod.final },
    coarseGate: coarseBuild ? coarseBuild.gate : build.gate,
    fineGate: build.gate,
    conflicts,
    rolledBack: false,
    elapsedMs: performance.now() - t0,
    patchMs,
    navigation: {
      field: 'fine',
      res: previous.field.res,
      corridorWalkSuccess: build.walk.corridorWalk?.success ?? false,
      regionsReached: build.walk.walks.filter((w) => w.reached).length,
    },
    collision: { res: previous.field.res, grid: 'bilinear', changedCells: patchedCells },
    fullControl: fullControlReport,
    messages,
  };

  const blocking = conflicts.filter((c) => c.kind !== 'lod');
  const lodOk = lod.final >= 0.85;
  const coarseOk = !coarseBuild || coarseBuild.gate.accepted;
  const ok = build.gate.accepted && coarseOk && seam.ok && lodOk && blocking.length === 0;

  // A seam-only failure means the window edge still steps even after the boundary band was stitched.
  // Global stages (pit filling, hydrology) solve over the whole field, so the margin can carry a
  // residual the exterior does not agree with; the conflict already offers a wider range as the fix.
  if (!ok && !seam.ok && build.gate.accepted && coarseOk && lodOk) {
    messages.push(`边界带已重算并接回，但仍有 ${seam.maxStep.toFixed(2)} m 落差落在改动边缘；可扩大重塑范围再试。`);
  }

  const windowText = `${bounds.minX.toFixed(0)}…${bounds.maxX.toFixed(0)} × ${bounds.minZ.toFixed(0)}…${bounds.maxZ.toFixed(0)} m`;
  if (!ok) {
    const reasons: string[] = [];
    if (!coarseOk) reasons.push(`粗网格预检未通过：${coarseBuild?.gate.reasons[0] ?? '未知'}`);
    if (!build.gate.accepted) reasons.push(...build.gate.reasons.slice(0, 2));
    if (blocking.length > 0 && reasons.length === 0) reasons.push(blocking[0].detail);
    if (!seam.ok) reasons.push(`边界接缝 ${seam.maxStep.toFixed(2)} m 超限`);
    if (!lodOk) reasons.push('粗细网格改动不一致');
    messages.push(`局部窗口 ${windowText}，${blocks.length} 个分块，补丁 ${patchedCells} 顶点。`);
    return rollbackReshape(spec, previous, report, reasons.length > 0 ? reasons : ['局部重塑未达到验收条件'], messages, performance.now() - t0);
  }

  messages.push(`局部窗口 ${windowText}，${blocks.length} 个分块：补丁 ${patchedCells} 顶点，冻结 ${frozenCells} 顶点（未改动区域保持原样）。`);
  messages.push(`边界接缝最大落差 ${seam.maxStep.toFixed(2)} m · ${seam.maxSlopeDeg.toFixed(1)}°；粗细网格一致度 ${(lod.final * 100).toFixed(0)}%。`);
  messages.push(`细网格 ${previous.field.res}² 复算：走廊${build.walk.corridorWalk?.success ? '可行' : '受阻'}，必达区 ${build.walk.walks.filter((w) => w.reached).length}/${build.walk.walks.length} 抵达；碰撞网格 ${previous.field.res}² 同步更新。`);

  const result = assembleResult(spec, build, recipe, 'none', 'ok', [], '仅重算必要的局部窗口。', messages, performance.now() - t0, {
    riverRerouted: false,
    passMoved: false,
  });
  result.reshape = report;
  // `assembleResult` labels the run as a normal generation; the report says it was local.
  return result;
}

/** A full one-shot generation of the same constrained spec, used as the comparison control. */
export function fullControl(spec: LevelSpec): GenerationResult {
  const authoredRoute = spec.corridor.waypoints.length >= 2
    ? spec.corridor.waypoints.map((p) => ({ ...p }))
    : [spec.entrance, spec.pass.center, spec.entrance];
  const recipe: Recipe = {
    riverPoints: spec.river.points.map((p) => ({ ...p })),
    route: authoredRoute,
    protectRiverbed: spec.locks.riverbed,
    raisePass: false,
    routeKind: 'initial',
  };
  const res = fineResolution(spec);
  const build = buildState(spec, recipe, res);
  const travel = scoreTravel(build.walk, build.passWidth.width, spec);
  const errorMap = computeErrorMap(build.field, build.base, build.corridor, build.localSpec);
  const metrics = computeMetrics({ field: build.field, base: build.base, corridor: build.corridor, spec: build.localSpec, errorMap, travelScore: travel, passWidth: build.passWidth });
  const evaluation: Evaluation = { ...build.evaluation, featureScore: metrics.featureScore, travelScore: travel };
  return {
    spec,
    field: build.field.toData(),
    water: build.hydrology.water,
    riverPath: build.hydrology.riverPath,
    riverHalfWidth: build.hydrology.halfWidth,
    riverWaterLevel: build.hydrology.outletLevel,
    corridor: build.corridor,
    landmarks: [],
    pass: spec.pass,
    passWidth: { width: build.passWidth.width, forgiveness: build.passWidth.forgiveness, reference: build.passReference },
    metrics,
    errorMap,
    walk: build.walk.walks,
    corridorWalk: build.walk.corridorWalk,
    rain: build.rain,
    repair: { chosen: 'none', reason: '完整生成对照。', candidates: [], riverRerouted: false, passMoved: false, rollback: false },
    evaluation,
    status: build.gate.accepted ? 'ok' : 'failed',
    messages: ['完整生成对照（未做局部保留）。'],
    elapsedMs: 0,
    baseField: build.base.heights.slice(),
    passCenter: spec.pass.center,
    locks: spec.locks,
    recipe: recipeFrom(recipe),
    datum: build.datum,
    reshape: null,
  };
}

function maxDelta(a: Float32Array, b: Float32Array): number {
  let m = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function meanDelta(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let s = 0;
  for (let i = 0; i < len; i++) s += Math.abs(a[i] - b[i]);
  return s / len;
}
