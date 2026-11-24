import {
  clamp,
  closestOnPolyline,
  dist2,
  lerp,
  makeNoise2D,
  PolylineIndex,
  smoothstep,
  smootherstep,
  withinBounds,
} from './math';
import type {
  CorridorData,
  CorridorSample,
  GenerationMetrics,
  HeightFieldData,
  LevelSpec,
  MustReachRegion,
  ReshapeBounds,
  SlopeHistogramBin,
  TerrainDatum,
  Vec2,
} from './types';

export const FEATURE_NAMES = ['山脊', '盆地', '必达区', '河道', '通行'] as const;

export class HeightField {
  readonly size: number;
  readonly res: number;
  readonly heights: Float32Array;
  readonly vertexCount: number;

  constructor(size: number, res: number) {
    this.size = size;
    this.res = res;
    this.vertexCount = res + 1;
    this.heights = new Float32Array(this.vertexCount * this.vertexCount);
  }

  static from(size: number, res: number, heights: Float32Array): HeightField {
    const f = new HeightField(size, res);
    f.heights.set(heights);
    return f;
  }

  clone(): HeightField {
    return HeightField.from(this.size, this.res, this.heights);
  }

  index(ix: number, iz: number): number {
    return iz * this.vertexCount + ix;
  }

  vertexX(ix: number): number {
    return -this.size / 2 + (ix / this.res) * this.size;
  }

  vertexZ(iz: number): number {
    return -this.size / 2 + (iz / this.res) * this.size;
  }

  get(ix: number, iz: number): number {
    const n = this.vertexCount;
    return this.heights[clamp(iz, 0, n - 1) * n + clamp(ix, 0, n - 1)];
  }

  set(ix: number, iz: number, h: number): void {
    const n = this.vertexCount;
    this.heights[clamp(iz, 0, n - 1) * n + clamp(ix, 0, n - 1)] = h;
  }

  sample(x: number, z: number, out?: { h: number; gx: number; gz: number }): number {
    const half = this.size / 2;
    const fx = clamp(((x + half) / this.size) * this.res, 0, this.res);
    const fz = clamp(((z + half) / this.size) * this.res, 0, this.res);
    const ix = Math.min(Math.floor(fx), this.res - 1);
    const iz = Math.min(Math.floor(fz), this.res - 1);
    const tx = fx - ix;
    const tz = fz - iz;
    const n = this.vertexCount;
    const h00 = this.heights[iz * n + ix];
    const h10 = this.heights[iz * n + ix + 1];
    const h01 = this.heights[(iz + 1) * n + ix];
    const h11 = this.heights[(iz + 1) * n + ix + 1];
    const h = lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
    if (out) {
      const step = this.size / this.res;
      out.h = h;
      out.gx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / step;
      out.gz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / step;
    }
    return h;
  }

  slopeDegAt(x: number, z: number): number {
    const g = { h: 0, gx: 0, gz: 0 };
    this.sample(x, z, g);
    return (Math.atan(Math.hypot(g.gx, g.gz)) * 180) / Math.PI;
  }

  minHeight(): number {
    let m = Infinity;
    for (const h of this.heights) m = Math.min(m, h);
    return m;
  }

  maxHeight(): number {
    let m = -Infinity;
    for (const h of this.heights) m = Math.max(m, h);
    return m;
  }

  resampleTo(res: number): Float32Array {
    if (res === this.res) return this.heights.slice();
    const out = new Float32Array((res + 1) * (res + 1));
    const n = this.vertexCount;
    const scale = this.res / res;
    for (let j = 0; j <= res; j++) {
      const sz = j * scale;
      const iz = Math.min(Math.floor(sz), this.res - 1);
      const tz = sz - iz;
      for (let i = 0; i <= res; i++) {
        const sx = i * scale;
        const ix = Math.min(Math.floor(sx), this.res - 1);
        const tx = sx - ix;
        const h00 = this.heights[iz * n + ix];
        const h10 = this.heights[iz * n + ix + 1];
        const h01 = this.heights[(iz + 1) * n + ix];
        const h11 = this.heights[(iz + 1) * n + ix + 1];
        out[j * (res + 1) + i] = lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
      }
    }
    return out;
  }

  toData(): HeightFieldData {
    return { size: this.size, res: this.res, heights: this.heights.slice() };
  }
}

export interface FeatureMasks {
  ridge: Float32Array;
  basin: Float32Array;
  region: Float32Array;
}

export interface PadDefinition {
  center: Vec2;
  radius: number;
  height: number;
  kind: 'entrance' | 'region';
  label?: string;
}

/**
 * The pass is a *col*: the ridge crest dips to a saddle height over a stretch of crest centred on
 * the pass, then rises back to full height. The ridge is not removed — the crest is lowered — so
 * the crossing keeps real relief and drains away on both flanks (a flat wind gap on the base
 * plain would trap runoff). Returns the along-crest tangent and the gap window in world space;
 * `gapFactor` is 0 at the col centre and 1 outside it.
 */
function passGap(center: Vec2, ridgePoints: Vec2[], inner: number, outer: number, sill: number): GapDefinition {
  const hit = closestOnPolyline(center.x, center.z, ridgePoints);
  const a = ridgePoints[Math.max(0, hit.segment)];
  const b = ridgePoints[Math.min(ridgePoints.length - 1, hit.segment + 1)];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { center, tangent: { x: dx / len, z: dz / len }, inner, outer, sill };
}

interface GapDefinition {
  center: Vec2;
  tangent: Vec2;
  inner: number;
  outer: number;
  /** Ridge contribution at the col, in metres. Keeps the saddle above the lowland so it drains. */
  sill: number;
}

/** Ridge height multiplier from every crossing gap: full height outside, `sill` at each col. */
function gapHeight(x: number, z: number, gaps: GapDefinition[], fullHeight: number): number {
  let h = fullHeight;
  for (const g of gaps) {
    const along = Math.abs((x - g.center.x) * g.tangent.x + (z - g.center.z) * g.tangent.z);
    h = lerp(g.sill, h, smoothstep(g.inner, g.outer, along));
  }
  return h;
}

export interface TerrainBuildOptions {
  /**
   * Replay onto an existing field. Heights outside `bounds` are never written, so already-confirmed
   * ground stays bit-for-bit identical during a local reshape.
   */
  seedHeights?: Float32Array;
  bounds?: ReshapeBounds | null;
  /** Freeze the map datum and col sill so a local edit cannot lift or lower the whole mountain. */
  freezeDatum?: boolean;
  datum?: TerrainDatum;
  /** Region labels whose landing pad must not be re-graded, with how far the map change reached each. */
  padPreserved?: { labels: string[]; bounds: ReshapeBounds }[];
}

function inBounds(bounds: ReshapeBounds | null | undefined, x: number, z: number): boolean {
  return !bounds || withinBounds(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, x, z);
}

/**
 * Cuts a shallow, monotone-descending trough along the authored river so the channel bed falls
 * from source to outlet. The bed is a monotone profile of the *path length* (not of terrain),
 * so the stream cannot climb and cannot pool in a high hollow; banks blend out over `width`.
 */
function carveDrainageValley(field: HeightField, spec: LevelSpec, bounds?: ReshapeBounds | null): void {
  const pts = spec.river.points;
  if (pts.length < 2) return;
  const path = resampleWaypoints(pts, Math.max(1.0, field.size / field.res * 0.8));
  if (path.length < 2) return;
  const halfWidth = Math.max(2.4, spec.river.halfWidth * 1.6);
  const bankWidth = halfWidth + 7;

  // The bed is the raw ground along the channel, but forced *downhill only*: a stream cannot
  // climb, so where the terrain rises downstream we hold the previous bed and cut through the
  // rise. Using the minimum of "terrain here" and "previous bed minus a hair" also guarantees
  // the final vertex is at or below every earlier point — the outlet is the lowest spot, so
  // runoff has a coherent, continuous path to it.
  const raw = path.map((p) => field.sample(p.x, p.z));
  const bed = new Array<number>(path.length);
  bed[0] = raw[0];
  for (let i = 1; i < path.length; i++) bed[i] = Math.min(raw[i], bed[i - 1] - 0.02);

  const index = new PolylineIndex(path, field.size, Math.max(4, bankWidth));
  const n = field.vertexCount;
  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.vertexX(ix);
      if (!inBounds(bounds, x, z)) continue;
      const hit = index.closest(x, z, 6);
      if (!hit || hit.distance > bankWidth) continue;
      const i = clamp(Math.round(hit.t), 0, path.length - 1);
      const bedHeight = bed[i] - CHANNEL_INCISION;
      const idx = iz * n + ix;
      const t = hit.distance / bankWidth;
      const target = lerp(bedHeight, field.heights[idx], smoothstep(0, 1, t));
      if (target < field.heights[idx]) field.heights[idx] = target;
    }
  }
}

const CHANNEL_INCISION = 0.6;

export interface TerrainBuild {
  field: HeightField;
  base: HeightField;
  masks: FeatureMasks;
  pads: PadDefinition[];
  regionTargets: Map<string, number>;
  padDistance: Float32Array;
  datum: TerrainDatum;
}

export function buildBaseTerrain(spec: LevelSpec, options: TerrainBuildOptions = {}): TerrainBuild {
  const res = spec.resolution;
  const field = options.seedHeights
    ? HeightField.from(spec.size, res, options.seedHeights)
    : new HeightField(spec.size, res);
  const bounds = options.bounds ?? null;
  const padPreserved = options.padPreserved ?? [];
  const n = res + 1;
  const noise = makeNoise2D(spec.seed);
  const offset = { x: (spec.seed % 997) * 1.7 + 13.1, z: (spec.seed % 761) * 2.3 + 7.7 };
  const goal = spec.landform;

  const ridgeMasks = spec.ridges.map((r) => {
    const m = new Float32Array(n * n);
    const width = Math.max(4, r.width);
    const sharp = Math.max(0.3, r.sharpness);
    for (let iz = 0; iz < n; iz++) {
      const z = field.vertexZ(iz);
      for (let ix = 0; ix < n; ix++) {
        const hit = closestOnPolyline(field.vertexX(ix), z, r.points);
        m[iz * n + ix] = Math.pow(1 - smootherstep(0, width, hit.distance), sharp);
      }
    }
    return m;
  });

  const basinMasks = spec.basins.map((b) => {
    const m = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      const z = field.vertexZ(iz);
      for (let ix = 0; ix < n; ix++) {
        const d = dist2(field.vertexX(ix), z, b.center.x, b.center.z);
        // Full basin out to 0.85R, then a short blend back into the surrounding slope.
        m[iz * n + ix] = 1 - smoothstep(b.radius * 0.85, b.radius * 1.15, d);
      }
    }
    return m;
  });

  const regionMask = new Float32Array(n * n);
  for (const r of spec.regions) {
    for (let iz = 0; iz < n; iz++) {
      const z = field.vertexZ(iz);
      for (let ix = 0; ix < n; ix++) {
        const v = 1 - smoothstep(r.radius * 0.85, r.radius * 2.1, dist2(field.vertexX(ix), z, r.center.x, r.center.z));
        if (v > regionMask[iz * n + ix]) regionMask[iz * n + ix] = v;
      }
    }
  }

  const maxRidge = spec.ridges.reduce((m, r) => Math.max(m, r.height), 0);
  const baseElev = options.freezeDatum && options.datum ? options.datum.baseElev : 7 + maxRidge * 0.1;
  const pr = spec.pass.radius;
  // The pass is a *col*: the ridge crest is lowered to a sill over a stretch of crest centred on
  // it, then climbs back to full height. Lowering the crest (rather than deleting the ridge)
  // keeps real relief across the crossing, so the saddle drains on both flanks instead of
  // becoming a flat plain that traps runoff.
  const sill = options.freezeDatum && options.datum ? options.datum.sill : maxRidge * 0.3;
  const gaps: GapDefinition[] = [
    passGap(spec.pass.center, spec.ridges[0]?.points ?? [], pr * 1.0, pr * 2.5, sill),
  ];
  if (spec.dryCol) {
    // The dry col is the alternative crossing for the "river locked" repair; it must be a real
    // lowered saddle too, or moving the trail would just walk it into another cliff.
    gaps.push(passGap(spec.dryCol.center, spec.ridges[0]?.points ?? [], spec.dryCol.radius * 0.9, spec.dryCol.radius * 2.2, sill));
  }

  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.vertexX(ix);
      if (!inBounds(bounds, x, z)) continue;
      const i = iz * n + ix;

      const macro = noise.fbm(x * 0.0016 + offset.x, z * 0.0016 + offset.z, 4);
      const detail = noise.fbm(x * 0.015 + offset.x, z * 0.015 + offset.z, 4);
      const crag = noise.ridged(x * 0.0042 + offset.x, z * 0.0042 + offset.z, 3);

      let h =
        baseElev +
        (macro - 0.48) * goal.relief * 1.5 +
        (detail - 0.5) * goal.roughness * 7 +
        (crag - 0.5) * goal.roughness * 4;

      // The crest is lowered at the pass, so the col is part of the landform rather than a
      // trench cut into a cliff face.
      for (let k = 0; k < spec.ridges.length; k++) {
        const r = spec.ridges[k];
        const crest = ridgeMasks[k][i];
        if (crest <= 0) continue;
        const ridgeHeight = gapHeight(x, z, gaps, r.height);
        h += crest * (ridgeHeight + (detail - 0.5) * goal.roughness * 2.2);
      }

      for (let k = 0; k < spec.basins.length; k++) {
        const b = spec.basins[k];
        const inside = basinMasks[k][i];
        if (inside <= 0) continue;
      // The rim is the natural terrain. The bowl wall must be climbable, because a must-reach
      // region can sit at the basin centre: cap the depth so the 0.25R–0.95R wall stays under the
      // character's grade. A deeper wall would force the corridor to cut it down (the
      // "flatten the mountain" failure) or make the region unreachable.
      const rimTarget = Math.max(h, b.floor + 1.5);
      // smoothstep's steepest point is 1.5× its average, so cap the average at ~0.6× the
      // character limit to keep the peak walkable.
      const climbTan = Math.tan((spec.character.maxSlopeDeg * 0.6 * Math.PI) / 180);
      const maxDepth = climbTan * b.radius * 0.7;
      const floorTarget = Math.max(Math.min(b.floor, rimTarget - 3), rimTarget - maxDepth);
      const bowl = lerp(rimTarget, floorTarget, smoothstep(0.25, 0.95, inside));
      h = lerp(h, bowl, inside * 0.94 * goal.basinDepth);
      }

      field.heights[i] = Math.max(h, baseElev * 0.2);
    }
  }

  // A river needs a valley, not a plain that happens to be lower than its spring. Cut a shallow
  // trough down the authored channel so the bed descends continuously from the pass to the
  // outlet; without this the runoff simulation has nowhere physically coherent to drain.
  carveDrainageValley(field, spec, bounds);

  const pads: PadDefinition[] = [];
  const regionTargets = new Map<string, number>();
  pads.push({
    center: { ...spec.entrance },
    radius: Math.max(4.5, spec.corridor.width * 1.1),
    height: averageHeight(field, spec.entrance, Math.max(4, spec.corridor.width)),
    kind: 'entrance',
    label: '入口',
  });
  for (const r of spec.regions) {
    const radius = Math.max(3.4, Math.min(r.radius * 0.55, 9));
    const local = averageHeight(field, r.center, radius);
    const target = r.targetHeight ?? local + goal.relief * 0.006;
    regionTargets.set(r.id, target);
    pads.push({ center: r.center, radius, height: target, kind: 'region', label: r.name });
  }

  // Pads stay at their target height; aprons are cone-limited so the pad is reachable.
  for (const pad of pads) {
    // A pad whose grading window lies wholly outside the patch is already part of the frozen
    // ground; re-grading it would seed from the *ungraded* base and add a lip that was not in the
    // confirmed map. Leave frozen pads exactly as they were.
    if (bounds && !padTouchesBounds(bounds, pad, pad.kind === 'region' ? 24 : 16)) continue;
    // A preserved region keeps its confirmed pad only if no authored change reached it. The pad body
    // is restored *after* the pipeline (see `restorePreservedPads`, called from `buildState`), since
    // the corridor bench runs over the lookout and would otherwise re-grade it.
    if (pad.kind === 'region' && shouldRestorePreservedPad(pad, padPreserved ?? [])) continue;
    const reach = pad.kind === 'region' ? 24 : 16;
    gradePadCone(field, pad.center, pad.radius, pad.height, spec.character.maxSlopeDeg * 0.92, reach, bounds);
  }

  const base = field.clone();
  const padDistance = polylineDistanceField(field, [spec.entrance, ...spec.regions.map((r) => r.center)], 100);
  return {
    field,
    base,
    masks: { ridge: combineMasks(ridgeMasks), basin: combineMasks(basinMasks), region: regionMask },
    pads,
    regionTargets,
    padDistance,
    datum: { baseElev, sill },
  };
}

/**
 * Restore a preserved region's confirmed bench inside the patch window, after every grading stage
 * (base terrain, corridor bench) has run. The body keeps the exact heights the designer approved;
 * nothing outside the pad body moves, so `mergeExterior` and the seed detail are unaffected.
 */
export function restorePreservedPads(
  field: HeightField,
  confirmed: Float32Array | null,
  pads: PadDefinition[],
  preserved: { labels: string[]; bounds: ReshapeBounds }[],
): void {
  if (!confirmed || confirmed.length !== field.heights.length || preserved.length === 0) return;
  const n = field.vertexCount;
  for (const pad of pads) {
    if (pad.kind !== 'region') continue;
    // Restore only a preserved pad the authored change did not reach: its label is listed and the
    // change footprint does not overlap the pad body. A pad the change reached must be re-graded.
    if (!shouldRestorePreservedPad(pad, preserved)) continue;
    const r2 = pad.radius * pad.radius;
    for (let iz = 0; iz < field.vertexCount; iz++) {
      const dz = field.vertexZ(iz) - pad.center.z;
      if (Math.abs(dz) > pad.radius) continue;
      for (let ix = 0; ix < field.vertexCount; ix++) {
        const dx = field.vertexX(ix) - pad.center.x;
        if (dx * dx + dz * dz > r2) continue;
        const idx = iz * n + ix;
        field.heights[idx] = confirmed[idx];
      }
    }
  }
}

function padTouchesBounds(bounds: ReshapeBounds, pad: PadDefinition, reach: number): boolean {
  return boundingBoxesOverlap(bounds, {
    minX: pad.center.x - pad.radius - reach,
    maxX: pad.center.x + pad.radius + reach,
    minZ: pad.center.z - pad.radius - reach,
    maxZ: pad.center.z + pad.radius + reach,
  });
}

/**
 * A preserved region keeps its confirmed pad only if no authored change reached it. The change
 * footprints (`bounds`) are compared against the pad body — not its grading apron — because a
 * nearby edit that only raises the approach still needs the pad levelled onto the new approach.
 */
function shouldRestorePreservedPad(pad: PadDefinition, preserved: { labels: string[]; bounds: ReshapeBounds }[]): boolean {
  for (const entry of preserved) {
    if (!entry.labels.includes(pad.label ?? '')) continue;
    const overlaps = boundingBoxesOverlap(entry.bounds, {
      minX: pad.center.x - pad.radius,
      maxX: pad.center.x + pad.radius,
      minZ: pad.center.z - pad.radius,
      maxZ: pad.center.z + pad.radius,
    });
    if (!overlaps) return true;
  }
  return false;
}

function boundingBoxesOverlap(a: ReshapeBounds, b: ReshapeBounds): boolean {
  return !(a.minX > b.maxX || a.maxX < b.minX || a.minZ > b.maxZ || a.maxZ < b.minZ);
}

function averageHeight(field: HeightField, center: Vec2, radius: number): number {
  let sum = 0;
  let count = 0;
  const n = field.vertexCount;
  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      if (dist2(field.vertexX(ix), z, center.x, center.z) > radius) continue;
      sum += field.heights[iz * n + ix];
      count++;
    }
  }
  return count > 0 ? sum / count : field.sample(center.x, center.z);
}

export function gradePadCone(
  field: HeightField,
  center: Vec2,
  radius: number,
  height: number,
  maxSlopeDeg: number,
  reach: number,
  bounds?: ReshapeBounds | null,
): void {
  const n = field.vertexCount;
  const res = field.res;
  const tanSlope = Math.tan((maxSlopeDeg * Math.PI) / 180);
  const outer = radius + reach;
  const ixMin = Math.max(0, Math.floor(((center.x - outer + field.size / 2) / field.size) * res));
  const ixMax = Math.min(res, Math.ceil(((center.x + outer + field.size / 2) / field.size) * res));
  const izMin = Math.max(0, Math.floor(((center.z - outer + field.size / 2) / field.size) * res));
  const izMax = Math.min(res, Math.ceil(((center.z + outer + field.size / 2) / field.size) * res));
  for (let iz = izMin; iz <= izMax; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = ixMin; ix <= ixMax; ix++) {
      const x = field.vertexX(ix);
      if (!inBounds(bounds, x, z)) continue;
      const d = dist2(x, z, center.x, center.z);
      if (d > outer) continue;
      const idx = iz * n + ix;
      if (d <= radius) {
        field.heights[idx] = lerp(field.heights[idx], height, 0.96);
        continue;
      }
      const allowed = tanSlope * (d - radius);
      const delta = field.heights[idx] - height;
      if (Math.abs(delta) > allowed) field.heights[idx] = height + Math.sign(delta) * allowed;
    }
  }
}

export function combineMasks(masks: Float32Array[]): Float32Array {
  if (masks.length === 0) return new Float32Array(0);
  const out = new Float32Array(masks[0].length);
  for (const m of masks) for (let i = 0; i < m.length; i++) if (m[i] > out[i]) out[i] = m[i];
  return out;
}

export function polylineDistanceField(field: HeightField, points: Vec2[], maxDist: number): Float32Array {
  const n = field.vertexCount;
  const out = new Float32Array(n * n).fill(maxDist);
  if (points.length < 2) return out;
  const cell = field.size / field.res;
  const step = Math.max(0.8, cell * 0.75);
  const reachCells = Math.ceil(maxDist / cell) + 1;
  const stamp = (x: number, z: number): void => {
    const cx = Math.round(((x + field.size / 2) / field.size) * field.res);
    const cz = Math.round(((z + field.size / 2) / field.size) * field.res);
    for (let iz = Math.max(0, cz - reachCells); iz <= Math.min(field.res, cz + reachCells); iz++) {
      const dz = field.vertexZ(iz) - z;
      for (let ix = Math.max(0, cx - reachCells); ix <= Math.min(field.res, cx + reachCells); ix++) {
        const dx = field.vertexX(ix) - x;
        const d = Math.sqrt(dx * dx + dz * dz);
        const idx = iz * n + ix;
        if (d < out[idx]) out[idx] = d;
      }
    }
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      stamp(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    }
  }
  return out;
}

export interface ErosionResult {
  carved: HeightField;
  incision: Float32Array;
}

/** Water-driven incision that follows the river axis and undercuts the pass corridor. */
export function erodeField(
  field: HeightField,
  spec: LevelSpec,
  amount: number,
  riverPoints: Vec2[],
  bounds?: ReshapeBounds | null,
): ErosionResult {
  const out = field.clone();
  const incision = new Float32Array(out.heights.length);
  const a = clamp(amount, 0, 1);
  if (a <= 0) return { carved: out, incision };
  const n = out.vertexCount;
  const noise = makeNoise2D(spec.seed * 31 + 991);
  const center = spec.pass.center;
  const reach = spec.pass.radius * 1.9;
  const depthBase = spec.landform.riverIncision * 1.6 + 6.5;
  const river = riverPoints.length >= 2 ? riverPoints : [center, center];
  const gorge = Math.max(spec.river.halfWidth * 1.5, 5.5);
  for (let iz = 0; iz < n; iz++) {
    const z = out.vertexZ(iz);
    if (Math.abs(z - center.z) > reach) continue;
    for (let ix = 0; ix < n; ix++) {
      const x = out.vertexX(ix);
      if (Math.abs(x - center.x) > reach) continue;
      if (!inBounds(bounds, x, z)) continue;
      const dPass = dist2(x, z, center.x, center.z);
      if (dPass > reach) continue;
      const dRiver = closestOnPolyline(x, z, river).distance;
      const envelope = Math.pow(1 - smoothstep(0, reach, dPass), 1.1);
      const channel = 1 - smoothstep(0, gorge, dRiver);
      const wob = noise.fbm(x * 0.019, z * 0.019, 3) - 0.5;
      // A narrow, deep notch right on the channel: this is the broken stretch the trail cannot
      // be graded across. Away from the channel the incision stays shallow and patchy.
      const depth = envelope * a * depthBase * (0.1 + channel * 2.6 + Math.abs(wob) * 0.35);
      const idx = iz * n + ix;
      out.heights[idx] -= depth;
      incision[idx] = depth;
    }
  }
  return { carved: out, incision };
}

/** Priority-flood pit filling so runoff can reach the outlet; authored basins stay as sinks. */
export function fillPits(
  field: HeightField,
  basins: import('./types').BasinDefinition[],
  skip: Vec2,
  skipRadius: number,
  maxFill = 7,
  protectedRoute?: Vec2[],
  bounds?: ReshapeBounds | null,
): number {
  const n = field.vertexCount;
  const res = field.res;
  const total = n * n;
  const basinMask = new Uint8Array(total);
  for (const b of basins) {
    for (let iz = 0; iz < n; iz++) {
      const dz = field.vertexZ(iz) - b.center.z;
      if (Math.abs(dz) > b.radius) continue;
      for (let ix = 0; ix < n; ix++) {
        const d = Math.hypot(field.vertexX(ix) - b.center.x, dz);
        if (d <= b.radius * 0.9) basinMask[iz * n + ix] = 1;
      }
    }
  }
  const keep = new Uint8Array(total);
  const cells = Math.ceil((skipRadius / field.size) * res);
  const cx = Math.round(((skip.x + field.size / 2) / field.size) * res);
  const cz = Math.round(((skip.z + field.size / 2) / field.size) * res);
  for (let iz = Math.max(0, cz - cells); iz <= Math.min(res, cz + cells); iz++) {
    for (let ix = Math.max(0, cx - cells); ix <= Math.min(res, cx + cells); ix++) {
      keep[iz * n + ix] = 1;
    }
  }
  // The graded bench is a *designed* cut/fill, not an erosion pit. Priority flooding would see
  // the ramp behind its embankment as a hollow and raise it right back, leaving the trail bridging
  // a wall. Protect the corridor footprint from pit filling.
  if (protectedRoute && protectedRoute.length >= 2) {
    const index = new PolylineIndex(protectedRoute, field.size, 8);
    for (let iz = 0; iz < n; iz++) {
      const z = field.vertexZ(iz);
      for (let ix = 0; ix < n; ix++) {
        if (index.closest(field.vertexX(ix), z, 6)) keep[iz * n + ix] = 1;
      }
    }
  }
  const filled = new Float32Array(field.heights);
  const visited = new Uint8Array(total);
  const heap = new MinHeapHeight();
  const seed = (ix: number, iz: number): void => {
    const idx = iz * n + ix;
    if (visited[idx]) return;
    visited[idx] = 1;
    heap.push(idx, filled[idx]);
  };
  for (let ix = 0; ix < n; ix++) {
    seed(ix, 0);
    seed(ix, res);
  }
  for (let iz = 0; iz < n; iz++) {
    seed(0, iz);
    seed(res, iz);
  }
  const dxs = [1, -1, 0, 0];
  const dzs = [0, 0, 1, -1];
  let raised = 0;
  while (heap.size > 0) {
    const { idx, level } = heap.pop()!;
    const ix = idx % n;
    const iz = (idx / n) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = ix + dxs[k];
      const nz = iz + dzs[k];
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nz * n + nx;
      if (visited[ni] || basinMask[ni] || keep[ni]) continue;
      visited[ni] = 1;
      // The flood always *propagates* through the whole field — stopping at the window edge would
      // turn the frozen exterior into a wall and raise interior hollows that already drained. Only
      // the height update is confined to the window, so the confirmed exterior stays bit-for-bit
      // and the interior drains against it exactly as a fully-frozen map would.
      const outside = !inBounds(bounds, field.vertexX(nx), field.vertexZ(nz));
      if (!outside) {
        const spill = Math.max(filled[ni], level + 0.02);
        if (spill - filled[ni] <= maxFill) {
          if (spill > filled[ni]) raised++;
          filled[ni] = spill;
        }
      }
      heap.push(ni, filled[ni]);
    }
  }
  field.heights.set(filled);
  return raised;
}

class MinHeapHeight {
  private idx: number[] = [];
  private val: number[] = [];
  push(idx: number, v: number): void {
    this.idx.push(idx);
    this.val.push(v);
    let i = this.idx.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.val[p] <= this.val[i]) break;
      this.swap(p, i);
      i = p;
    }
  }
  pop(): { idx: number; level: number } | undefined {
    if (this.idx.length === 0) return undefined;
    const idx = this.idx[0];
    const level = this.val[0];
    const lastIdx = this.idx.pop()!;
    const lastVal = this.val.pop()!;
    if (this.idx.length > 0) {
      this.idx[0] = lastIdx;
      this.val[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.idx.length && this.val[l] < this.val[best]) best = l;
        if (r < this.idx.length && this.val[r] < this.val[best]) best = r;
        if (best === i) break;
        this.swap(best, i);
        i = best;
      }
    }
    return { idx, level };
  }
  get size(): number {
    return this.idx.length;
  }
  private swap(a: number, b: number): void {
    [this.idx[a], this.idx[b]] = [this.idx[b], this.idx[a]];
    [this.val[a], this.val[b]] = [this.val[b], this.val[a]];
  }
}

export interface CorridorBuildOptions {
  route: Vec2[];
  riverPath: Vec2[];
  halfWidth: number;
  shoulder: number;
  water: Uint8Array;
  waterLevel: number;
  protectWater: boolean;
  riverKeepout: number;
  reference: HeightField;
  maxSlopeDeg: number;
  /**
   * Depth of erosion incision per vertex. The trail cannot be graded across a deep ravine (this
   * level has no bridges), so cells above `ravineDepth` are left untouched and the crossing is
   * reported blocked — that is what routes the author into the repair planner.
   */
  incision?: Float32Array | null;
  ravineDepth?: number;
  /** Only vertices inside this window are re-graded; the rest of the field stays frozen. */
  bounds?: ReshapeBounds | null;
}

export function buildCorridorOn(spec: LevelSpec, field: HeightField, opts: CorridorBuildOptions): CorridorData | null {
  if (!opts.route || opts.route.length < 2) return null;
  const res = field.res;
  const n = field.vertexCount;
  const halfWidth = opts.halfWidth;
  const shoulder = opts.shoulder;
  const slopeLimit = Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180);
  const maxGrade = slopeLimit * 0.8;

  const dense = resampleWaypoints(opts.route, Math.max((field.size / res) * 0.7, 1.0));
  if (dense.length < 2) return null;

  const samples: CorridorSample[] = dense.map((p) => ({
    x: p.x,
    z: p.z,
    nx: 0,
    nz: 1,
    h: field.sample(p.x, p.z),
    base: field.sample(p.x, p.z),
    grade: 0,
    netWidth: 0,
    waterHalfWidth: 0,
    distanceToRiver: Infinity,
    cut: 0,
    fill: 0,
  }));

  for (let i = 0; i < samples.length; i++) {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    samples[i].nx = -tz / len;
    samples[i].nz = tx / len;
  }

  const minWidth = spec.character.radius * 2 + 0.6;
  const cell = field.size / res;
  const nominal = Math.max(halfWidth, minWidth / 2) + 0.25;
  // The flat bench must be at least ~1.2 cells wide or a coarse mesh can leave the
  // centreline on ungraded vertices and render as a cliff after subdivision.
  const inner = Math.max(nominal, cell * 1.25);

  for (const s of samples) {
    const dPass = dist2(s.x, s.z, spec.pass.center.x, spec.pass.center.z);
    const lip = 1 - smoothstep(spec.pass.radius * 0.55, spec.pass.radius * 1.7, dPass);
    s.distanceToRiver = opts.riverPath.length >= 2 ? closestOnPolyline(s.x, s.z, opts.riverPath).distance : Infinity;
    s.waterHalfWidth = opts.riverPath.length >= 2 && s.distanceToRiver <= inner + spec.river.halfWidth + 1 ? spec.river.halfWidth : 0;
    s.netWidth = inner * 2 * lerp(1, 0.92, lip);
  }

  // Grade profile: clamp steps to the character envelope, then smooth and re-clamp.
  const clampProfile = (): void => {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const allowed = maxGrade * run;
      const delta = b.h - a.h;
      if (Math.abs(delta) > allowed) b.h = a.h + Math.sign(delta) * allowed;
    }
    for (let i = samples.length - 2; i >= 0; i--) {
      const a = samples[i];
      const b = samples[i + 1];
      const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const allowed = maxGrade * run;
      const delta = a.h - b.h;
      if (Math.abs(delta) > allowed) a.h = b.h + Math.sign(delta) * allowed;
    }
  };
  clampProfile();
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < samples.length - 1; i++) {
      samples[i].h = samples[i - 1].h * 0.22 + samples[i].h * 0.56 + samples[i + 1].h * 0.22;
    }
    clampProfile();
  }
  // Where the authored route folds back on itself (switchback at a pass), samples that are far
  // apart along the path sit next to each other in space. Equalise their heights in *space* so
  // the two arms merge into one turning terrace; otherwise the nearest-branch lookup produces a
  // transverse bank steeper than the character can cross.
  const mergeRadius = inner * 2.2;
  for (let pass = 0; pass < 24; pass++) {
    const next = samples.map((s) => s.h);
    for (let i = 0; i < samples.length; i++) {
      let sum = 0;
      let weight = 0;
      for (let j = 0; j < samples.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(samples[j].x - samples[i].x, samples[j].z - samples[i].z);
        if (d > mergeRadius) continue;
        const w = (1 - d / mergeRadius) ** 2;
        sum += samples[j].h * w;
        weight += w;
      }
      if (weight > 0) next[i] = lerp(samples[i].h, sum / weight, 0.6);
    }
    for (let i = 0; i < samples.length; i++) samples[i].h = next[i];
    clampProfile();
  }
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    const run = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    samples[i].grade = (b.h - a.h) / run;
  }

  // Grade the bench, then blend outward with a slope-limited cone apron.
  // Outside the bench, clamp the *existing* ground into the cone [bench ± tanWalk·(d-inner)]:
  // hillside above it gets cut down (a walkable cut face), hollow below it gets filled up
  // (a walkable embankment), and ground already inside the cone is left alone. Because both
  // terms stay continuous as the cone widens, the band joins the authored terrain without a
  // cliff — including at the inside of a switchback, where sample heights were merged in space.
  const riverIndex = opts.riverPath.length >= 2 ? new PolylineIndex(opts.riverPath, field.size, 10) : null;
  const baseCopy = (opts.reference ?? field).heights.slice();
  const cellArea = cell * cell;
  const tanWalk = Math.tan((spec.character.maxSlopeDeg * 0.84 * Math.PI) / 180);
  const apronEnd = inner + 9;
  const index = new PolylineIndex(samples, field.size, Math.max(6, inner * 1.6));
  const incision = opts.incision ?? null;
  const ravineDepth = opts.ravineDepth ?? Infinity;
  let cutVolume = 0;
  let fillVolume = 0;
  let disturbed = 0;
  let blocked = 0;

  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.vertexX(ix);
      if (!inBounds(opts.bounds, x, z)) continue;
      const hit = index.closest(x, z, 8);
      if (!hit || hit.distance > apronEnd) continue;
      const idx = iz * n + ix;
      // This level has no bridges: leave the ravine floor exactly as erosion cut it. Grading it
      // would silently fill the broken stretch and hide the defect from the repair planner.
      if (incision && incision[idx] > ravineDepth) {
        if (hit.distance <= inner) blocked++;
        continue;
      }
      if (opts.protectWater && riverIndex) {
        const dRiver = riverIndex.closest(x, z)?.distance ?? Infinity;
        if (dRiver < opts.riverKeepout) continue;
      }
      const original = baseCopy.length === field.heights.length ? baseCopy[idx] : field.heights[idx];
      const bench = interpolateSampleHeight(samples, hit.t);
      let target: number;
      if (hit.distance <= inner) {
        target = bench;
      } else {
        const allowed = tanWalk * (hit.distance - inner);
        target = clamp(original, bench - allowed, bench + allowed);
      }
      const move = target - field.heights[idx];
      if (move < 0) cutVolume += -move * cellArea;
      else fillVolume += move * cellArea;
      if (Math.abs(move) > 0.35) disturbed++;
      field.heights[idx] = target;
    }
  }

  // Audit net width on the current (already refined by the caller in the final pass) mesh.
  for (const s of samples) {
    if (incision && ravineAt(field, incision, s.x, s.z) > ravineDepth) {
      // The bench could not be graded here (an unbridged ravine): the crossing is broken.
      s.netWidth = 0;
      continue;
    }
    if (opts.protectWater && s.waterHalfWidth > 0) {
      s.netWidth = 0;
      continue;
    }
    s.netWidth = measureNetWidth(field, s, inner, shoulder, slopeLimit, opts.waterLevel, opts.protectWater, riverIndex, opts.riverKeepout);
  }

  let passSampleIndex = 0;
  let bestPass = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = dist2(samples[i].x, samples[i].z, spec.pass.center.x, spec.pass.center.z);
    if (d < bestPass) {
      bestPass = d;
      passSampleIndex = i;
    }
  }

  let length = 0;
  for (let i = 1; i < samples.length; i++) {
    length += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
  }

  let maxGradeSeen = 0;
  let minNet = Infinity;
  for (const s of samples) {
    maxGradeSeen = Math.max(maxGradeSeen, Math.abs(s.grade));
    if (s.netWidth > 0.001) minNet = Math.min(minNet, s.netWidth);
  }

  return {
    samples,
    width: inner * 2,
    shoulder,
    length,
    maxGrade: maxGradeSeen,
    minNetWidth: Number.isFinite(minNet) ? minNet : 0,
    passSampleIndex,
    routeKind: 'initial',
    disturbedFraction: field.heights.length > 0 ? disturbed / field.heights.length : 0,
    cutVolume,
    fillVolume,
  };
}

/** Erosion incision depth at a world point (bilinear), used to detect an unbridgeable ravine. */
function ravineAt(field: HeightField, incision: Float32Array, x: number, z: number): number {
  const res = field.res;
  const fx = clamp(((x + field.size / 2) / field.size) * res, 0, res - 1e-6);
  const fz = clamp(((z + field.size / 2) / field.size) * res, 0, res - 1e-6);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const n = res + 1;
  const a = incision[iz * n + ix];
  const b = incision[iz * n + ix + 1];
  const c = incision[(iz + 1) * n + ix];
  const d = incision[(iz + 1) * n + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

function interpolateSampleHeight(samples: CorridorSample[], t: number): number {  const i = clamp(Math.floor(t), 0, samples.length - 1);
  const frac = clamp(t - i, 0, 1);
  const a = samples[i].h;
  const b = samples[Math.min(samples.length - 1, i + 1)].h;
  return a + (b - a) * frac;
}

function measureNetWidth(
  field: HeightField,
  s: CorridorSample,
  inner: number,
  shoulder: number,
  slopeLimit: number,
  waterLevel: number,
  protectWater: boolean,
  riverIndex: PolylineIndex | null,
  riverKeepout: number,
): number {
  const step = Math.max(0.4, field.size / field.res * 0.5);
  const reach = inner + shoulder + 3;
  const hCenter = field.sample(s.x, s.z);
  const side = (dir: number): number => {
    let free = 0;
    for (let d = step; d <= reach; d += step) {
      const x = s.x + s.nx * dir * d;
      const z = s.z + s.nz * dir * d;
      if (Math.abs(x) > field.size / 2 - 1 || Math.abs(z) > field.size / 2 - 1) break;
      const h = field.sample(x, z);
      if (h < waterLevel - 0.05) break;
      if (Math.abs(h - hCenter) > 1.0) break;
      const prev = field.sample(s.x + s.nx * dir * (d - step), s.z + s.nz * dir * (d - step));
      if (Math.abs(h - prev) / step > slopeLimit * 1.05) break;
      if (protectWater && riverIndex) {
        const hit = riverIndex.closest(x, z);
        if (hit && hit.distance < riverKeepout) break;
      }
      free = d;
    }
    return free;
  };
  return side(1) + side(-1);
}

export function resampleWaypoints(pts: Vec2[], spacing: number): Vec2[] {
  const out: Vec2[] = [];
  if (pts.length === 0) return out;
  out.push({ ...pts[0] });
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len === 0) continue;
    let d = spacing - carry;
    while (d < len) {
      const t = d / len;
      out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > 0.05) out.push({ ...last });
  return out;
}

export interface PassWidth {
  width: number;
  forgiveness: number;
}

/** Widest walkable chord through the pass. Measures dry, slope-compliant terrain only. */
export function estimatePassNetWidth(
  field: HeightField,
  spec: LevelSpec,
  waterLevel: number,
  reference?: Vec2,
  water?: Uint8Array,
): PassWidth {
  const slopeLimit = Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180);
  const step = Math.max(0.5, field.size / field.res * 0.5);
  const ref = reference ?? spec.pass.center;
  const reach = spec.pass.radius * 1.55;
  if (field.sample(ref.x, ref.z) < waterLevel + 0.05) return { width: 0, forgiveness: 0 };

  const ray = (angle: number): number => {
    let d = step;
    let prev = field.sample(ref.x, ref.z);
    for (; d <= reach; d += step) {
      const x = ref.x + Math.cos(angle) * d;
      const z = ref.z + Math.sin(angle) * d;
      if (Math.abs(x) > field.size / 2 - 1 || Math.abs(z) > field.size / 2 - 1) break;
      const h = field.sample(x, z);
      if (h < waterLevel + 0.05) break;
      if (Math.abs(h - prev) / step > slopeLimit * 1.05) break;
      if (water) {
        const ix = clamp(Math.round(((x + field.size / 2) / field.size) * field.res), 0, field.res);
        const iz = clamp(Math.round(((z + field.size / 2) / field.size) * field.res), 0, field.res);
        if (water[iz * field.vertexCount + ix]) break;
      }
      prev = h;
    }
    return d - step;
  };

  const dirs = 20;
  const radii: number[] = [];
  for (let k = 0; k < dirs; k++) radii.push(ray((k / dirs) * Math.PI * 2));
  let best = 0;
  let open = 0;
  for (let k = 0; k < dirs; k++) {
    if (radii[k] > step * 1.2) open++;
    const opposite = radii[(k + dirs / 2) % dirs];
    best = Math.max(best, radii[k] + opposite);
  }
  return { width: best, forgiveness: open / dirs };
}

export interface StatsInput {
  field: HeightField;
  base: HeightField;
  corridor: CorridorData | null;
  spec: LevelSpec;
  errorMap: Float32Array;
  travelScore: number;
  passWidth: PassWidth;
}

export function computeMetrics(input: StatsInput): GenerationMetrics {
  const { field, base, corridor, spec, errorMap } = input;
  const n = field.vertexCount;
  const step = field.size / field.res;
  const slopes: number[] = [];
  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const hx = (field.get(ix + 1, iz) - field.get(ix - 1, iz)) / (2 * step);
      const hz = (field.get(ix, iz + 1) - field.get(ix, iz - 1)) / (2 * step);
      slopes.push((Math.atan(Math.hypot(hx, hz)) * 180) / Math.PI);
    }
  }
  slopes.sort((a, b) => a - b);

  let cutVolume = 0;
  let fillVolume = 0;
  let disturbed = 0;
  for (let i = 0; i < field.heights.length; i++) {
    const d = field.heights[i] - base.heights[i];
    if (Math.abs(d) > 0.35) disturbed++;
    if (d < 0) cutVolume += -d;
    else fillVolume += d;
  }
  const disturbance = field.heights.length > 0 ? disturbed / field.heights.length : 0;

  const slopeLimitRad = Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180);
  let maxGrade = 0;
  let minNetWidth = Infinity;
  let gradeViolations = 0;
  let widthViolations = 0;
  const requiredWidth = spec.character.radius * 2 + 0.6;
  if (corridor) {
    for (const s of corridor.samples) {
      maxGrade = Math.max(maxGrade, Math.abs(s.grade));
      if (s.netWidth >= requiredWidth) minNetWidth = Math.min(minNetWidth, s.netWidth);
      if (Math.abs(s.grade) > slopeLimitRad * 1.05) gradeViolations++;
      if (s.netWidth < requiredWidth) widthViolations++;
    }
  }

  const ridgeFidelity = ridgeFidelityAt(field, spec);
  const basinFidelity = basinFidelityAt(field, spec);
  const regionFidelity = regionFidelityAt(field, spec);
  const featureScore = ridgeFidelity * 0.4 + basinFidelity * 0.35 + regionFidelity * 0.25;

  let flat = 0;
  let flatTotal = 0;
  for (let iz = 1; iz < n - 1; iz += 2) {
    for (let ix = 1; ix < n - 1; ix += 2) {
      const hx = (field.get(ix + 1, iz) - field.get(ix - 1, iz)) / (2 * step);
      const hz = (field.get(ix, iz + 1) - field.get(ix, iz - 1)) / (2 * step);
      if (Math.hypot(hx, hz) < 0.02) flat++;
      flatTotal++;
    }
  }

  let errorSum = 0;
  for (let i = 0; i < errorMap.length; i++) errorSum += errorMap[i];
  const generationError = errorMap.length > 0 ? errorSum / errorMap.length : 0;

  return {
    maxGrade,
    minNetWidth: Number.isFinite(minNetWidth) ? minNetWidth : 0,
    requiredWidth,
    gradeViolations,
    widthViolations: widthViolations + (input.passWidth.width < requiredWidth ? 1 : 0),
    passNetWidth: input.passWidth.width,
    passForgiveness: input.passWidth.forgiveness,
    ridgeFidelity,
    basinFidelity,
    regionFidelity,
    featureScore,
    travelScore: input.travelScore,
    disturbance,
    cutVolume: corridor?.cutVolume ?? cutVolume,
    fillVolume: corridor?.fillVolume ?? fillVolume,
    flattenFraction: flatTotal > 0 ? flat / flatTotal : 0,
    generationError,
    slopeHistogram: buildHistogram(slopes),
    corridorLength: corridor?.length ?? 0,
    corridorDeviation: 0,
    medianSlopeDeg: slopes.length > 0 ? slopes[(slopes.length / 2) | 0] : 0,
  };
}

function ridgeFidelityAt(field: HeightField, spec: LevelSpec): number {
  const samples: number[] = [];
  for (const r of spec.ridges) {
    for (const p of r.points) {
      if (dist2(p.x, p.z, spec.pass.center.x, spec.pass.center.z) < spec.pass.radius * 1.8) continue;
      const center = field.sample(p.x, p.z);
      const hit = closestOnPolyline(p.x, p.z, r.points);
      const prev = r.points[Math.max(0, hit.segment)];
      const next = r.points[Math.min(r.points.length - 1, hit.segment + 1)];
      const tx = next.x - prev.x;
      const tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      const off = field.sample(p.x + (-tz / len) * r.width * 2.2, p.z + (tx / len) * r.width * 2.2);
      samples.push(clamp(Math.abs(center - off) / Math.max(1.5, r.height * 0.3), 0, 1));
    }
  }
  return samples.length > 0 ? mean(samples) : 1;
}

function basinFidelityAt(field: HeightField, spec: LevelSpec): number {
  const samples: number[] = [];
  for (const b of spec.basins) {
    const center = field.sample(b.center.x, b.center.z);
    let rim = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      rim = Math.max(rim, field.sample(b.center.x + Math.cos(a) * b.radius * 1.15, b.center.z + Math.sin(a) * b.radius * 1.15));
    }
    samples.push(clamp((rim - center) / Math.max(2, (b.rim - b.floor) * 0.3), 0, 1));
  }
  return samples.length > 0 ? mean(samples) : 1;
}

function regionFidelityAt(field: HeightField, spec: LevelSpec): number {
  const samples: number[] = [];
  for (const r of spec.regions) {
    const h = field.sample(r.center.x, r.center.z);
    let relief = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      relief = Math.max(relief, Math.abs(field.sample(r.center.x + Math.cos(a) * r.radius * 1.3, r.center.z + Math.sin(a) * r.radius * 1.3) - h));
    }
    const heightOk = r.targetHeight !== undefined
      ? 1 - clamp(Math.abs(h - r.targetHeight) / Math.max(2.5, spec.landform.relief * 0.2), 0, 1)
      : 1;
    samples.push(heightOk * 0.6 + clamp(relief / 3, 0, 1) * 0.4);
  }
  return samples.length > 0 ? mean(samples) : 1;
}

function mean(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function buildHistogram(sorted: number[]): SlopeHistogramBin[] {
  const edges = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 90];
  const bins: SlopeHistogramBin[] = [];
  let cursor = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    let count = 0;
    while (cursor < sorted.length && sorted[cursor] < hi) {
      if (sorted[cursor] >= lo) count++;
      cursor++;
    }
    bins.push({ from: lo, to: hi, fraction: sorted.length > 0 ? count / sorted.length : 0 });
  }
  return bins;
}

export function computeErrorMap(field: HeightField, base: HeightField, corridor: CorridorData | null, spec: LevelSpec): Float32Array {
  const n = field.vertexCount;
  const out = new Float32Array(n * n);
  const slopeLimit = Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180);
  const step = field.size / field.res;
  const samples = corridor?.samples ?? [];
  const index = samples.length > 1 ? new PolylineIndex(samples, field.size, 12) : null;
  const reach = corridor ? spec.corridor.width / 2 + spec.corridor.shoulder + 5 : 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const hx = (field.get(ix + 1, iz) - field.get(ix - 1, iz)) / (2 * step);
      const hz = (field.get(ix, iz + 1) - field.get(ix, iz - 1)) / (2 * step);
      const slope = Math.hypot(hx, hz);
      let err = Math.max(0, slope - slopeLimit) * 6;
      err += Math.abs(field.heights[i] - base.heights[i]) * 0.08;
      if (index) {
        const hit = index.closest(field.vertexX(ix), field.vertexZ(iz));
        if (hit && hit.distance < reach) {
          const expected = interpolateSampleHeight(samples, hit.t);
          const along = Math.abs(slope - Math.abs(samples[Math.min(samples.length - 1, Math.round(hit.t))].grade));
          err += along * 14;
          err += Math.max(0, Math.abs(field.heights[i] - expected) - 1.2) * 1.1;
        }
      }
      out[i] = err;
    }
  }
  return out;
}

export function heightStats(field: HeightField): { min: number; max: number } {
  return { min: field.minHeight(), max: field.maxHeight() };
}

export function regionTargetList(spec: LevelSpec, targets: Map<string, number>): MustReachRegion[] {
  return spec.regions.map((r) => ({ ...r, targetHeight: targets.get(r.id) ?? r.targetHeight }));
}
