import { clamp, closestOnPolyline, dist2, PolylineIndex, withinBounds } from './math';
import {
  HeightField,
  buildBaseTerrain,
  buildCorridorOn,
  computeErrorMap,
  computeMetrics,
  erodeField,
  estimatePassNetWidth,
  fillPits,
  heightStats,
  restorePreservedPads,
  type PassWidth,
} from './terrain';
import { buildHydrology, reconnectDownstream, refreshWater, simulateRain, type Hydrology } from './hydrology';
import {
  buildNavGrid,
  meanDistanceToRoute,
  planAndWalk,
  profilePath,
  routeLength,
  type NavGrid,
  type WalkPlan,
} from './navigation';
import type {
  CorridorData,
  Evaluation,
  GenerationOptions,
  GenerationRecipe,
  GenerationResult,
  LevelSpec,
  LevelStatus,
  PlayableSnapshot,
  RainResult,
  RepairCandidateReport,
  RepairKind,
  ReshapeBounds,
  TerrainDatum,
  Vec2,
} from './types';

const MAX_FINE_RES = 300;
const COARSE_RES = 132;

export interface Recipe {
  riverPoints: Vec2[];
  route: Vec2[];
  protectRiverbed: boolean;
  raisePass: boolean;
  routeKind: CorridorData['routeKind'];
}

export interface BuildStateOptions {
  /**
   * Seed the replay with this field instead of generating terrain from scratch. For a local
   * reshape this is the previous confirmed field: inside the window it is regenerated in place,
   * outside it stays exactly as seeded (and is re-asserted by `outerHeights` after the pipeline).
   */
  seedHeights?: Float32Array;
  /** Limit terrain writes to this window (local reshape). */
  bounds?: ReshapeBounds | null;
  /** Reuse the datum/col sill of the map being patched. */
  freezeDatum?: boolean;
  datum?: TerrainDatum;
  /**
   * After the pipeline has rebuilt the window, copy these already-confirmed heights back outside
   * it. This is what keeps explored, frozen terrain bit-for-bit identical.
   */
  outerHeights?: Float32Array;
  /** Matching water state for the frozen exterior. */
  outerHydrology?: Hydrology;
  /** Region labels whose landing pad must not be re-graded, and the footprints that may touch them. */
  padPreserved?: { labels: string[]; bounds: ReshapeBounds }[];
  /**
   * Footprint of the authored change itself (plus its grading reach). The boundary band is stitched
   * only in the window *margin* outside this footprint: that margin is where untouched ground picked
   * up global coupling, while inside the footprint the new solve is the authored result and must be
   * left alone.
   */
  changeFootprint?: ReshapeBounds | null;
}

export interface StateBuild {
  field: HeightField;
  base: HeightField;
  hydrology: Hydrology;
  corridor: CorridorData | null;
  nav: NavGrid;
  walk: WalkPlan;
  rain: RainResult;
  passWidth: PassWidth;
  passReference: Vec2;
  errorMap: Float32Array;
  metrics: ReturnType<typeof computeMetrics>;
  gate: { accepted: boolean; reasons: string[] };
  evaluation: Evaluation;
  localSpec: LevelSpec;
  fordApplied: number;
  datum: TerrainDatum;
}

export function recipeOf(recipe: Recipe): GenerationRecipe {
  return {
    riverPoints: recipe.riverPoints.map((p) => ({ ...p })),
    route: recipe.route.map((p) => ({ ...p })),
    protectRiverbed: recipe.protectRiverbed,
    raisePass: recipe.raisePass,
    routeKind: recipe.routeKind,
  };
}

export function recipeFrom(recipe: GenerationRecipe): Recipe {
  return {
    riverPoints: recipe.riverPoints.map((p) => ({ ...p })),
    route: recipe.route.map((p) => ({ ...p })),
    protectRiverbed: recipe.protectRiverbed,
    raisePass: recipe.raisePass,
    routeKind: recipe.routeKind,
  };
}

export function coarseResolution(spec: LevelSpec): number {
  return Math.min(COARSE_RES, spec.resolution);
}

export function fineResolution(spec: LevelSpec): number {
  return Math.max(spec.resolution, Math.min(MAX_FINE_RES, Math.round(spec.resolution * 1.9)));
}

export function buildState(spec: LevelSpec, recipe: Recipe, res: number, options: BuildStateOptions = {}): StateBuild {
  const terrain = buildBaseTerrain({ ...spec, resolution: res }, {
    seedHeights: options.seedHeights,
    bounds: options.bounds,
    freezeDatum: options.freezeDatum,
    datum: options.datum,
    padPreserved: options.padPreserved,
  });
  let field = terrain.field;
  const base = terrain.base;

  let incision: Float32Array | null = null;
  if (spec.erosion > 0) {
    const eroded = erodeField(field, spec, spec.erosion, recipe.riverPoints, options.bounds);
    field = eroded.carved;
    incision = eroded.incision;
  }
  if (recipe.raisePass) {
    raisePassSlope(field, spec, options.bounds);
    recipe = { ...recipe, riverPoints: rerouteRiverBesidePass(field, spec, recipe.riverPoints, options.bounds) };
  }

  // Drain the incidental pits erosion leaves behind; authored basins remain sinks. Pit filling is
  // a global flood, so it always runs over the whole field — restricting it to the window would
  // turn the frozen exterior into a wall and raise interior hollows that already drained.
  fillPits(field, spec.basins, spec.pass.center, spec.pass.radius * 1.15);
  // Region target heights anchor feature scoring and landmark fidelity.
  const regionTargets = new Map<string, number>();
  for (const r of spec.regions) regionTargets.set(r.id, field.sample(r.center.x, r.center.z));
  const regionsWithTargets = spec.regions.map((r) => ({ ...r, targetHeight: regionTargets.get(r.id) }));
  const localSpec: LevelSpec = {
    ...spec,
    resolution: res,
    regions: regionsWithTargets,
    pass: { ...spec.pass },
    river: { ...spec.river, points: recipe.riverPoints.map((p) => ({ ...p })) },
    corridor: { ...spec.corridor, waypoints: recipe.route.map((p) => ({ ...p })) },
  };

  let hydrology = buildHydrology(field, spec, recipe.riverPoints);

  const corridor = buildCorridorOn(localSpec, field, {
    route: recipe.route,
    riverPath: hydrology.riverPath,
    halfWidth: spec.corridor.width / 2,
    shoulder: spec.corridor.shoulder,
    water: hydrology.water,
    waterLevel: hydrology.outletLevel,
    protectWater: recipe.protectRiverbed,
    riverKeepout: Math.max(2.0, spec.river.halfWidth + 0.8),
    reference: base,
    maxSlopeDeg: spec.character.maxSlopeDeg,
    incision: recipe.raisePass ? null : incision,
    ravineDepth: 1.6,
    bounds: options.bounds,
  });
  if (corridor) corridor.routeKind = recipe.routeKind;

  let fordApplied = 0;
  if (!recipe.protectRiverbed) {
    fordApplied = applyFords(field, spec, corridor, hydrology);
    if (fordApplied > 0) {
      // Only re-evaluate depth: rebuilding would recut the channel and undo the ford.
      hydrology = refreshWater(field, hydrology, spec);
    }
  }

  // Grading the bench can close small hollows at the foot of its embankments (the corridor is
  // built after the first pit-fill). Left alone these hold rain forever and the runoff audit
  // rightly fails, so drain them now — authored basins, the pass saddle and the bench itself stay
  // exempt (filling the bench would restore the very wall it was cut through).
  if (
    corridor &&
    fillPits(
      field,
      spec.basins,
      spec.pass.center,
      spec.pass.radius * 1.15,
      2.5,
      corridor.samples.map((s) => ({ x: s.x, z: s.z })),
    ) > 0
  ) {
    hydrology = refreshWater(field, hydrology, spec);
  }

  // Copy the already-confirmed exterior back so no frozen vertex or water cell drifts. The window
  // was sized to contain every change, so anything outside it must be identical to before. If the
  // previous field is at a different resolution we cannot honour "frozen exterior" at all, so
  // refuse the patch rather than silently re-grading every frozen vertex.
  if (options.outerHeights && options.bounds) {
    if (options.outerHeights.length !== field.heights.length) {
      throw new Error(
        `local reshape needs the previous field at the same resolution (${previousResolution(options)}² vs ${field.res}²); regenerate the playable map first.`,
      );
    }
    mergeExterior(field, hydrology, options.outerHeights, options.outerHydrology ?? null, options.bounds, options.changeFootprint ?? null);
    // A preserved region keeps the exact bench the designer approved. Do this after every grading
    // stage (the corridor bench runs over the lookout), and before nav/width so those read it.
    restorePreservedPads(field, options.outerHeights, terrain.pads, options.padPreserved ?? []);
  }

  const passReference = corridor ? nearestPassSample(corridor, spec.pass.center) : spec.pass.center;
  const passWidth = estimatePassNetWidth(field, localSpec, hydrology.outletLevel, passReference, hydrology.water);

  const nav = buildNavGrid(field, localSpec, corridor, hydrology.outletLevel, hydrology.depth);
  const walk = planAndWalk(nav, field, localSpec, spec.regions, corridor, hydrology.outletLevel, hydrology.depth);
  const rain = simulateRain({
    field,
    spec: localSpec,
    hydrology,
    basins: spec.basins,
    particles: 160,
    recordTraces: 36,
  });

  const travelScore = scoreTravel(walk, passWidth.width, spec);
  const errorMap = computeErrorMap(field, base, corridor, localSpec);
  const metrics = computeMetrics({
    field,
    base,
    corridor,
    spec: localSpec,
    errorMap,
    travelScore,
    passWidth,
  });
  if (corridor) {
    metrics.corridorDeviation = meanDistanceToRoute(
      recipe.route,
      corridor.samples.map((s) => ({ x: s.x, z: s.z })),
    );
  }

  const gate = gateState(walk, corridor, passWidth.width, rain, metrics, spec);
  const evaluation = jointScore(gate, metrics, travelScore);
  return {
    field,
    base,
    hydrology,
    corridor,
    nav,
    walk,
    rain,
    passWidth,
    passReference,
    errorMap,
    metrics,
    gate,
    evaluation,
    localSpec,
    fordApplied,
    datum: terrain.datum,
  };
}

function previousResolution(options: BuildStateOptions): string {
  const len = options.outerHeights?.length ?? 0;
  const res = Math.round(Math.sqrt(len)) - 1;
  return Number.isFinite(res) && res > 0 ? String(res) : '?';
}

/** Restore frozen ground and water outside the patch window after the pipeline replays. */
function mergeExterior(
  field: HeightField,
  hydrology: Hydrology,
  outer: Float32Array,
  outerHydrology: Hydrology | null,
  bounds: ReshapeBounds,
  changeFootprint: ReshapeBounds | null,
): void {
  const n = field.vertexCount;
  if (outer.length !== field.heights.length) return;
  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.vertexX(ix);
      if (withinBounds(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, x, z)) continue;
      field.heights[iz * n + ix] = outer[iz * n + ix];
      if (outerHydrology) {
        hydrology.water[iz * n + ix] = outerHydrology.water[iz * n + ix];
        hydrology.depth[iz * n + ix] = outerHydrology.depth[iz * n + ix];
        hydrology.surface[iz * n + ix] = outerHydrology.surface[iz * n + ix];
        hydrology.connected[iz * n + ix] = outerHydrology.connected[iz * n + ix];
      }
    }
  }
  stitchBoundaryBand(field, outer, bounds, changeFootprint);
}
/**
 * The interior replay runs the *global* pit-fill, so even ground the authored change never reaches
 * can shift a metre or two where the new watershed differs from the old. The window is snapped out
 * to whole blocks, which leaves a margin of just such untouched ground inside it; freezing the
 * exterior right beside that margin would leave the shift as a step at the window edge.
 *
 * Recompute the boundary band: inside the first ring, keep the confirmed (pre-reshape) height so the
 * join to the frozen exterior is exactly the step that was there before; ramp that correction to zero
 * over the next few cells so the new solve resumes continuously. Only the margin is touched — the
 * authored change lies deeper inside the window — and no exterior vertex moves.
 */
function stitchBoundaryBand(field: HeightField, outer: Float32Array, bounds: ReshapeBounds, changeFootprint: ReshapeBounds | null): void {
  const n = field.vertexCount;
  const res = field.res;
  const cell = field.size / res;
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.vertexX(ix);
      if (!withinBounds(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, x, z)) continue;
      // Never touch authored ground: inside the change footprint the replay *is* the design.
      if (changeFootprint && withinBounds(changeFootprint.minX, changeFootprint.maxX, changeFootprint.minZ, changeFootprint.maxZ, x, z)) continue;
      // Whole-cell rings from the window edge: 0 is the outermost inside vertex, which must meet
      // the frozen exterior exactly, then the correction ramps to zero over `band` rings.
      const edge = Math.min(x - bounds.minX, bounds.maxX - x, z - bounds.minZ, bounds.maxZ - z);
      const ring = Math.max(0, Math.floor(edge / cell));
      if (ring > 8) continue;
      const idx = iz * n + ix;
      const residual = Math.abs(outer[idx] - field.heights[idx]);
      if (residual < 1e-3) continue;
      // Enough rings that each step stays under ~25°; never so wide it reaches the authored change.
      const band = Math.min(6, Math.max(1, Math.ceil(residual / (cell * Math.tan((25 * Math.PI) / 180)))));
      if (ring >= band) continue;
      const w = 1 - smooth(ring / band);
      field.heights[idx] += (outer[idx] - field.heights[idx]) * w;
    }
  }
}

function nearestPassSample(corridor: CorridorData, p: Vec2): Vec2 {
  let best = corridor.samples[0];
  let bestD = Infinity;
  for (const s of corridor.samples) {
    const d = dist2(s.x, s.z, p.x, p.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { x: best.x, z: best.z };
}

export function scoreTravel(walk: WalkPlan, passWidth: number, spec: LevelSpec): number {
  const total = Math.max(1, walk.walks.length);
  const reached = walk.walks.filter((w) => w.reached).length / total;
  const corridorOk = walk.corridorWalk?.success ? 1 : 0;
  const required = spec.character.radius * 2 + 0.6;
  const width = clamp(passWidth / Math.max(required * 1.6, 0.01), 0, 1);
  return reached * 0.58 + corridorOk * 0.3 + width * 0.12;
}

function gateState(
  walk: WalkPlan,
  corridor: CorridorData | null,
  passWidth: number,
  rain: RainResult,
  metrics: ReturnType<typeof computeMetrics>,
  spec: LevelSpec,
): { accepted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const slopeLimit = Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180);
  const required = spec.character.radius * 2 + 0.6;
  if (!corridor) reasons.push('未生成作者通路。');
  if (corridor) {
    if (corridor.maxGrade > slopeLimit * 1.04) {
      reasons.push(`通路最大坡度 ${((Math.atan(corridor.maxGrade) * 180) / Math.PI).toFixed(1)}° 超过角色上限 ${spec.character.maxSlopeDeg}°。`);
    }
    if (corridor.minNetWidth < required) {
      reasons.push(`通路最小净宽 ${corridor.minNetWidth.toFixed(2)} m 不足（需 ${required.toFixed(2)} m）。`);
    }
  }
  const unreached = walk.walks.filter((w) => !w.reached);
  if (unreached.length > 0) {
    const v = unreached[0].violations[0];
    reasons.push(`角色未走通：${unreached.map((w) => w.label).join('、')}${v ? `（${v}）` : ''}。`);
  }
  if (!walk.corridorWalk?.success) {
    const v = walk.corridorWalk?.violations[0];
    reasons.push(`作者通路无法全程通行${v ? `：${v}` : ''}。`);
  }
  if (!rain.success) reasons.push(`降雨验收未通过：${rain.summary}`);
  if (spec.locks.pass && passWidth < required) {
    reasons.push(`旧山口被锁定，但实测净宽仅 ${passWidth.toFixed(2)} m。`);
  }
  if (metrics.ridgeFidelity < 0.32) reasons.push('山脊形态被明显削弱，不满足已声明地貌。');
  if (metrics.flattenFraction > 0.5) reasons.push('大片地形接近平面，违反地貌目标。');
  return { accepted: reasons.length === 0, reasons };
}

function jointScore(
  gate: { accepted: boolean; reasons: string[] },
  metrics: ReturnType<typeof computeMetrics>,
  travelScore: number,
): Evaluation {
  const featureScore = metrics.featureScore;
  const joint = travelScore * 0.55 + featureScore * 0.45;
  const reasons = [...gate.reasons];
  if (travelScore < 0.55) reasons.push(`通行评分 ${(travelScore * 100).toFixed(0)}% 偏低。`);
  if (featureScore < 0.4) reasons.push(`地貌特征评分 ${(featureScore * 100).toFixed(0)}% 偏低。`);
  return { accepted: reasons.length === 0, reasons, featureScore, travelScore, jointScore: joint };
}

/** Fill the incised notch back into a coherent saddle while keeping the ridge shoulders. */
export function raisePassSlope(field: HeightField, spec: LevelSpec, bounds?: ReshapeBounds | null): void {
  const radius = spec.pass.radius * 2.0;
  const center = spec.pass.center;
  const n = field.vertexCount;
  // Rim height: median of the ring just outside the notch.
  const ring: number[] = [];
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    ring.push(field.sample(center.x + Math.cos(a) * radius, center.z + Math.sin(a) * radius));
  }
  ring.sort((a, b) => a - b);
  const rim = ring[Math.floor(ring.length * 0.35)] + 0.6;
  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    if (Math.abs(z - center.z) > radius) continue;
    for (let ix = 0; ix < n; ix++) {
      const x = field.vertexX(ix);
      if (!inBoundsLocal(bounds, x, z)) continue;
      const d = dist2(x, z, center.x, center.z);
      if (d > radius) continue;
      const w = 1 - smoothstep01(radius * 0.2, radius, d);
      const idx = iz * n + ix;
      const target = rim - Math.max(0, 1 - d / (spec.pass.radius * 0.9)) * 0.35;
      field.heights[idx] = Math.max(field.heights[idx], field.heights[idx] + (target - field.heights[idx]) * w * 0.96);
    }
  }
}

/** Shift the reach near the pass sideways so the corridor can occupy the old pass centre. */
export function rerouteRiverBesidePass(
  field: HeightField,
  spec: LevelSpec,
  riverPoints: Vec2[],
  bounds?: ReshapeBounds | null,
): Vec2[] {
  if (riverPoints.length < 2) return riverPoints;
  const center = spec.pass.center;
  const reach = spec.pass.radius * 2.4;
  const offset = spec.pass.radius * 0.72;
  const tangent = riverTangentAt(riverPoints, center);
  const normal = { x: -tangent.z, z: tangent.x };

  // Choose the side that is lower on average (easier to cut the spillway).
  let bestSign = 1;
  let bestMean = Infinity;
  for (const sign of [1, -1]) {
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const t = (k / 8) * 2 - 1;
      sum += field.sample(center.x + normal.x * offset * sign + tangent.x * t * spec.pass.radius, center.z + normal.z * offset * sign + tangent.z * t * spec.pass.radius);
    }
    if (sum < bestMean) {
      bestMean = sum;
      bestSign = sign;
    }
  }
  return riverPoints.map((p) => {
    const d = dist2(p.x, p.z, center.x, center.z);
    if (d > reach || !inBoundsLocal(bounds, p.x, p.z)) return { ...p };
    const w = 1 - smoothstep01(spec.pass.radius * 0.4, reach, d);
    return { x: p.x + normal.x * offset * bestSign * w, z: p.z + normal.z * offset * bestSign * w };
  });
}

function inBoundsLocal(bounds: ReshapeBounds | null | undefined, x: number, z: number): boolean {
  return !bounds || withinBounds(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ, x, z);
}

function riverTangentAt(points: Vec2[], at: Vec2): Vec2 {
  const hit = closestOnPolyline(at.x, at.z, points);
  const a = points[Math.max(0, hit.segment)];
  const b = points[Math.min(points.length - 1, hit.segment + 1)];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

/** A dry crossing offset laterally from the river, still inside the saddle. */
export function offsetPassCrossing(spec: LevelSpec, riverPoints: Vec2[], route: Vec2[]): Vec2[] {
  const center = spec.pass.center;
  const offset = Math.max(spec.pass.radius * 0.62, spec.river.halfWidth + spec.corridor.width / 2 + 2.5);
  const tangent = riverTangentAt(riverPoints, center);
  let normal = { x: -tangent.z, z: tangent.x };
  // Pick the side closer to the approach so the detour is short.
  const near = route.reduce((best, p) => (dist2(p.x, p.z, center.x, center.z) < dist2(best.x, best.z, center.x, center.z) ? p : best), route[0]);
  const toNear = { x: near.x - center.x, z: near.z - center.z };
  if (normal.x * toNear.x + normal.z * toNear.z < 0) normal = { x: -normal.x, z: -normal.z };
  const crossing = { x: center.x + normal.x * offset, z: center.z + normal.z * offset };
  const out: Vec2[] = [];
  let inserted = false;
  for (const p of route) {
    if (!inserted && dist2(p.x, p.z, center.x, center.z) < spec.pass.radius * 0.9) {
      out.push(crossing);
      inserted = true;
    } else if (dist2(p.x, p.z, center.x, center.z) > spec.pass.radius * 1.35) {
      out.push(p);
    }
  }
  if (!inserted) {
    // No point near the pass: insert the crossing at the closest segment position.
    let bestI = 1;
    let bestD = Infinity;
    for (let i = 0; i < route.length; i++) {
      const d = dist2(route[i].x, route[i].z, center.x, center.z);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    out.splice(bestI, 0, crossing);
  }
  // Deduplicate near-identical consecutive points.
  const clean: Vec2[] = [];
  for (const p of out) {
    if (clean.length === 0 || Math.hypot(p.x - clean[clean.length - 1].x, p.z - clean[clean.length - 1].z) > 1.2) clean.push(p);
  }
  return clean.length >= 2 ? clean : route;
}

/**
 * Wet/shallow ford where the trail crosses an unprotected stream. Only for shallow gorges.
 *
 * The streambed is raised to the *nearest* trail sample's height, not to any sample within a
 * radius: where the trail runs beside the river, using a farther (higher) sample lifted the
 * bed above the local bench and left a 0.5 m lip that failed the disc-clearance audit.
 */
function applyFords(field: HeightField, spec: LevelSpec, corridor: CorridorData | null, hydrology: Hydrology): number {
  if (!corridor) return 0;
  const n = field.vertexCount;
  const half = hydrology.halfWidth;
  const reach = half + spec.corridor.width / 2 + 1.2;
  const near = corridor.samples.filter((s) => s.distanceToRiver <= reach);
  if (near.length === 0) return 0;
  const index = new PolylineIndex(near, field.size, Math.max(4, half + 2));
  let count = 0;
  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.vertexX(ix);
      const riverHit = closestOnPolyline(x, z, hydrology.riverPath);
      if (riverHit.distance > half) continue;
      const hit = index.closest(x, z, 6);
      if (!hit) continue;
      const s = near[Math.round(hit.t)];
      // Refuse to bridge a deep gorge; the repair path is meant to handle that.
      if (s.h - field.heights[iz * n + ix] > 2.4) continue;
      const ford = s.h - 0.1;
      const idx = iz * n + ix;
      if (field.heights[idx] < ford) {
        field.heights[idx] = ford;
        count++;
      }
    }
  }
  return count;
}

const smoothstep01 = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function describeGap(build: StateBuild | null): string {
  if (!build) return '';
  const r = build.gate.reasons[0];
  return r ? `：${r}` : '';
}

export function generateLevel(spec: LevelSpec, options: GenerationOptions = {}): GenerationResult {
  const t0 = performance.now();
  const messages: string[] = [];
  const coarse = coarseResolution(spec);
  const authoredRoute = spec.corridor.waypoints.length >= 2
    ? spec.corridor.waypoints.map((p) => ({ ...p }))
    : [spec.entrance, spec.pass.center, spec.entrance];

  const baseRecipe: Recipe = {
    riverPoints: spec.river.points.map((p) => ({ ...p })),
    route: authoredRoute,
    protectRiverbed: spec.locks.riverbed,
    raisePass: false,
    routeKind: 'initial',
  };

  const initial = buildState(spec, baseRecipe, coarse);
  messages.push(`粗网格 ${coarse}² 预检：${initial.gate.accepted ? '作者通路可行' : '作者通路受阻'}。`);
  if (spec.erosion > 0.01) messages.push(`侵蚀河谷在山口一带切断了旧步道（侵蚀强度 ${(spec.erosion * 100).toFixed(0)}%）。`);

  let chosen: RepairKind = initial.gate.accepted ? 'none' : 'failed' as RepairKind;
  let chosenBuild = initial;
  let chosenRecipe = baseRecipe;
  let repairReason = initial.gate.accepted ? '无需修补。' : '';
  let riverRerouted = false;
  let passMoved = false;
  const candidates: RepairCandidateReport[] = [];
  let status: LevelStatus = initial.gate.accepted ? 'ok' : 'failed';

  if (!initial.gate.accepted) {
    const crossingOverlap = crossingOverlapsRiver(initial, spec);
    messages.push(
      crossingOverlap
        ? '走廊在山口的过河段与河道重叠，净宽被水系占用。'
        : '走廊在当前地形上无法维持坡度或净宽。',
    );

    // Candidate A — move the hiking corridor, keep the water system intact.
    const rerouteRoute = spec.corridor.detour?.length
      ? spec.corridor.detour.map((p) => ({ ...p }))
      : offsetPassCrossing(spec, baseRecipe.riverPoints, authoredRoute);
    const rerouteRecipe: Recipe = {
      ...baseRecipe,
      protectRiverbed: true,
      routeKind: 'rerouted',
      route: rerouteRoute,
    };
    const rerouteBuild = spec.locks.pass
      ? null
      : buildState(spec, rerouteRecipe, coarse);
    const rerouteAllowed = !spec.locks.pass;
    const rerouteFeasible = !!rerouteBuild && rerouteBuild.gate.accepted;
    const rerouteCost = rerouteBuild
      ? rerouteBuild.metrics.corridorLength * (1 + rerouteBuild.metrics.maxGrade * 2.1) + rerouteBuild.metrics.disturbance * 320
      : Infinity;
    candidates.push({
      kind: 'reroute-trail',
      allowed: rerouteAllowed,
      feasible: rerouteFeasible,
      traversalCost: rerouteCost,
      disturbance: rerouteBuild?.metrics.disturbance ?? Infinity,
      minNetWidth: rerouteBuild?.corridor?.minNetWidth ?? 0,
      maxGrade: rerouteBuild?.corridor?.maxGrade ?? 0,
      note: !rerouteAllowed
        ? '旧山口被锁定，走廊必须留在旧山口，不能只靠移走走廊。'
        : rerouteFeasible
          ? '保持河床与出水口不动，把登山走廊横移到鞍部干地重建。'
          : `移走走廊仍不可行${describeGap(rerouteBuild)}`,
    });

    // Candidate B — keep the old pass, fill the slope, reroute runoff downstream.
    const raiseRecipe: Recipe = {
      ...baseRecipe,
      protectRiverbed: false,
      raisePass: true,
      routeKind: 'restored',
      route: authoredRoute,
    };
    const raiseBuild = spec.locks.riverbed ? null : buildState(spec, raiseRecipe, coarse);
    const raiseAllowed = !spec.locks.riverbed;
    const raiseFeasible = !!raiseBuild && raiseBuild.gate.accepted;
    const raiseCost = raiseBuild
      ? raiseBuild.metrics.corridorLength * (1 + raiseBuild.metrics.maxGrade * 1.9) + raiseBuild.metrics.disturbance * 340
      : Infinity;
    candidates.push({
      kind: 'raise-pass',
      allowed: raiseAllowed,
      feasible: raiseFeasible,
      traversalCost: raiseCost,
      disturbance: raiseBuild?.metrics.disturbance ?? Infinity,
      minNetWidth: raiseBuild?.corridor?.minNetWidth ?? 0,
      maxGrade: raiseBuild?.corridor?.maxGrade ?? 0,
      note: !raiseAllowed
        ? '河床被锁定，填高坡面并改道径流会违反锁定。'
        : raiseFeasible
          ? '填高被切开的坡面重修旧山口，并把径流改道后接回下游。'
          : `填高坡面后仍不可行${describeGap(raiseBuild)}`,
    });

    const previous = options.previous ?? null;
    candidates.push({
      kind: 'rollback',
      allowed: !!previous,
      feasible: !!previous,
      traversalCost: Math.min(rerouteCost, raiseCost) * 0.9,
      disturbance: previous ? Math.min(
        Number.isFinite(rerouteBuild?.metrics.disturbance ?? Infinity) ? rerouteBuild!.metrics.disturbance : Infinity,
        Number.isFinite(raiseBuild?.metrics.disturbance ?? Infinity) ? raiseBuild!.metrics.disturbance : Infinity,
      ) * 0.3 : Infinity,
      minNetWidth: previous?.corridor.minNetWidth ?? 0,
      maxGrade: previous?.corridor.maxGrade ?? 0,
      note: previous ? `回退到「${previous.label}」。` : '没有可回退的上一张可通关地图。',
    });

    const feasible: { kind: RepairKind; recipe: Recipe; build: StateBuild; cost: number }[] = [];
    if (rerouteAllowed && rerouteFeasible && rerouteBuild) feasible.push({ kind: 'reroute-trail', recipe: rerouteRecipe, build: rerouteBuild, cost: rerouteCost });
    if (raiseAllowed && raiseFeasible && raiseBuild) feasible.push({ kind: 'raise-pass', recipe: raiseRecipe, build: raiseBuild, cost: raiseCost });

    let picked = feasible[0] ?? null;
    if (spec.repairPreference === 'raise-pass') picked = feasible.find((c) => c.kind === 'raise-pass') ?? picked;
    else if (spec.repairPreference === 'reroute-trail') picked = feasible.find((c) => c.kind === 'reroute-trail') ?? picked;
    if (picked && spec.repairPreference === 'auto') {
      picked = [...feasible].sort((a, b) => a.cost - b.cost)[0];
    }

    if (picked) {
      chosen = picked.kind;
      chosenBuild = picked.build;
      chosenRecipe = picked.recipe;
      status = 'repaired';
      riverRerouted = picked.kind === 'raise-pass';
      passMoved = picked.kind === 'raise-pass';
      repairReason = picked.kind === 'reroute-trail'
        ? `保留河床与山口水系，把登山走廊横移到鞍部干地：新路线 ${chosenBuild.metrics.corridorLength.toFixed(0)} m，扰动 ${(chosenBuild.metrics.disturbance * 100).toFixed(1)}%。`
        : `填高被切开的坡面重修旧山口，并把上游径流改道后接回下游：扰动 ${(chosenBuild.metrics.disturbance * 100).toFixed(1)}%，挖方 ${chosenBuild.metrics.cutVolume.toFixed(0)} m³。`;
    } else if (previous) {
      return rollbackResult(spec, previous, candidates, messages, repairReason || '所有修补方案不可行，保留上一张可通关地图。', t0, initial);
    } else {
      chosen = 'none';
      status = 'failed';
      repairReason = '河床与旧山口同时锁定：走廊必须穿过旧山口，而山口被水系占用且水系不可动，净宽无解；也没有可回退的上一张可通关地图。';
    }
  }

  // Fine-mesh verification of the chosen recipe: subdivision audit for width and height jumps.
  let finalBuild = chosenBuild;
  if (chosen !== 'none' && status !== 'failed') {
    const fine = fineResolution(spec);
    const verified = buildState(spec, { ...chosenRecipe, protectRiverbed: spec.locks.riverbed && chosen === 'reroute-trail' }, fine);
    messages.push(`细分网格 ${fine}² 复核：山口净宽 ${verified.passWidth.width.toFixed(2)} m，通路最大坡度 ${gradeDeg(verified.corridor?.maxGrade ?? 0).toFixed(1)}°。`);
    if (verified.gate.accepted) {
      finalBuild = verified;
    } else {
      messages.push(`细分复核未通过：${verified.gate.reasons[0] ?? '未知原因'}。`);
      if (options.previous) {
        return rollbackResult(spec, options.previous, candidates, messages, `细分网格复核发现粗网格掩盖了断崖/净宽问题，回退到「${options.previous.label}」。`, t0, verified);
      }
      finalBuild = verified;
      status = 'failed';
    }
  } else if (chosen === 'none') {
    // No repair needed: still verify the initial state on the fine mesh.
    const fine = fineResolution(spec);
    const verified = buildState(spec, baseRecipe, fine);
    messages.push(`细分网格 ${fine}² 复核：山口净宽 ${verified.passWidth.width.toFixed(2)} m，通路最大坡度 ${gradeDeg(verified.corridor?.maxGrade ?? 0).toFixed(1)}°。`);
    if (!verified.gate.accepted) {
      messages.push(`细分复核未通过：${verified.gate.reasons[0] ?? '未知原因'}。`);
      if (options.previous) {
        return rollbackResult(spec, options.previous, candidates, messages, `细分网格复核未通过，回退到「${options.previous.label}」。`, t0, verified);
      }
      finalBuild = verified;
      status = 'failed';
    } else {
      finalBuild = verified;
      status = 'ok';
    }
  }

  if (status === 'repaired' && !finalBuild.gate.accepted) status = 'failed';
  const elapsedMs = performance.now() - t0;
  const hist = heightStats(finalBuild.field);
  messages.push(`高程 ${hist.min.toFixed(1)}–${hist.max.toFixed(1)} m，坡度中位 ${finalBuild.metrics.medianSlopeDeg.toFixed(1)}°。`);

  return assembleResult(spec, finalBuild, chosenRecipe, chosen, status, candidates, repairReason, messages, elapsedMs, {
    riverRerouted,
    passMoved,
  });
}

function crossingOverlapsRiver(build: StateBuild, spec: LevelSpec): boolean {
  if (!build.corridor) return false;
  return build.corridor.samples.some(
    (s) => s.waterHalfWidth > 0 && s.netWidth < spec.character.radius * 2 + 0.6,
  );
}

function gradeDeg(g: number): number {
  return (Math.atan(g) * 180) / Math.PI;
}

function rollbackResult(
  spec: LevelSpec,
  previous: PlayableSnapshot,
  candidates: RepairCandidateReport[],
  messages: string[],
  reason: string,
  t0: number,
  attempted: StateBuild,
): GenerationResult {
  messages.push(`保留上一张可通关地图「${previous.label}」；本次改动未应用。`);
  return {
    spec,
    field: { ...previous.field, heights: previous.field.heights.slice() },
    water: previous.water.slice(),
    riverPath: previous.riverPath.map((p) => ({ ...p })),
    riverHalfWidth: previous.riverHalfWidth,
    riverWaterLevel: previous.riverWaterLevel,
    corridor: previous.corridor,
    landmarks: previous.landmarks,
    pass: spec.pass,
    passWidth: previous.passWidth,
    metrics: { ...previous.metrics, travelScore: attempted.metrics.travelScore },
    errorMap: previous.errorMap,
    walk: previous.walk,
    corridorWalk: previous.corridorWalk,
    rain: previous.rain,
    repair: {
      chosen: 'rollback',
      reason,
      candidates: candidates.map((c) => (c.kind === 'rollback' ? { ...c, allowed: true, feasible: true } : c)),
      riverRerouted: false,
      passMoved: false,
      rollback: true,
      previousLabel: previous.label,
    },
    evaluation: previous.evaluation,
    status: 'rolled-back',
    messages,
    elapsedMs: performance.now() - t0,
    baseField: previous.baseField,
    passCenter: previous.passCenter,
    locks: spec.locks,
    snapshotLabel: previous.label,
    recipe: previous.recipe,
    datum: previous.datum,
  };
}

export function assembleResult(
  spec: LevelSpec,
  build: StateBuild,
  recipe: Recipe,
  chosen: RepairKind,
  status: LevelStatus,
  candidates: RepairCandidateReport[],
  reason: string,
  messages: string[],
  elapsedMs: number,
  flags: { riverRerouted: boolean; passMoved: boolean },
): GenerationResult {
  const landmarks = spec.regions.map((r) => ({
    id: r.id,
    name: r.name,
    center: r.center,
    radius: r.radius,
    order: r.order,
    target: build.field.sample(r.center.x, r.center.z),
    relief: landmarkRelief(build.field, r.center, r.radius),
  }));
  return {
    spec,
    field: build.field.toData(),
    water: build.hydrology.water,
    riverPath: build.hydrology.riverPath.map((p) => ({ ...p })),
    riverHalfWidth: build.hydrology.halfWidth,
    riverWaterLevel: build.hydrology.outletLevel,
    corridor: build.corridor,
    landmarks,
    pass: spec.pass,
    passWidth: { width: build.passWidth.width, forgiveness: build.passWidth.forgiveness, reference: build.passReference },
    metrics: build.metrics,
    errorMap: build.errorMap,
    walk: build.walk.walks,
    corridorWalk: build.walk.corridorWalk,
    rain: build.rain,
    repair: {
      chosen,
      reason,
      candidates,
      riverRerouted: flags.riverRerouted,
      passMoved: flags.passMoved,
      rollback: false,
    },
    evaluation: build.evaluation,
    status,
    messages,
    elapsedMs,
    baseField: build.base.heights.slice(),
    passCenter: recipe.route.length > 0 ? spec.pass.center : spec.pass.center,
    locks: spec.locks,
    recipe: recipeOf(recipe),
    datum: build.datum,
    hydrology: build.hydrology,
    reshape: null,
  };
}

function landmarkRelief(field: HeightField, center: Vec2, radius: number): number {
  const h = field.sample(center.x, center.z);
  let relief = 0;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    relief = Math.max(relief, Math.abs(field.sample(center.x + Math.cos(a) * radius * 1.4, center.z + Math.sin(a) * radius * 1.4) - h));
  }
  return relief;
}

export function toSnapshot(result: GenerationResult, label: string): PlayableSnapshot | null {
  if (!result.corridor || !result.corridorWalk) return null;
  if (!result.evaluation.accepted) return null;
  if (result.status === 'failed' || result.status === 'rolled-back') return null;
  return {
    label,
    spec: result.spec,
    field: result.field,
    water: result.water,
    riverPath: result.riverPath,
    riverHalfWidth: result.riverHalfWidth,
    riverWaterLevel: result.riverWaterLevel,
    corridor: result.corridor,
    landmarks: result.landmarks,
    metrics: result.metrics,
    walk: result.walk,
    corridorWalk: result.corridorWalk,
    rain: result.rain,
    evaluation: result.evaluation,
    errorMap: result.errorMap,
    baseField: result.baseField,
    passCenter: result.passCenter,
    passWidth: result.passWidth,
    recipe: result.recipe,
    datum: result.datum,
    hydrology: result.hydrology,
  };
}

export function exportPackage(result: GenerationResult): string {
  const f = result.field;
  return JSON.stringify(
    {
      format: 'ridgeline.level',
      version: 1,
      seed: result.spec.seed,
      size: f.size,
      resolution: f.res,
      character: result.spec.character,
      heights: Array.from(f.heights, (h) => Math.round(h * 100) / 100),
      water: Array.from(result.water),
      spec: result.spec,
      collision: {
        grid: 'bilinear',
        requiredWidth: result.metrics.requiredWidth,
        maxSlopeDeg: result.spec.character.maxSlopeDeg,
        stepHeight: result.spec.character.stepHeight,
      },
      navigation: {
        corridor: (result.corridorWalk?.points ?? []).map((p) => ({ x: r2(p.x), z: r2(p.z), y: r2(p.y) })),
        regions: result.walk.map((w) => ({
          id: w.regionId,
          path: w.points.map((p) => ({ x: r2(p.x), z: r2(p.z), y: r2(p.y) })),
          reached: w.reached,
        })),
      },
      metrics: result.metrics,
      status: result.status,
    },
    null,
    1,
  );
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

export { routeLength, profilePath, reconnectDownstream };
