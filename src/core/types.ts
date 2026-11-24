import type { Vec2 } from './math';

export type { Vec2 } from './math';

export interface CharacterSpec {
  radius: number;
  height: number;
  maxSlopeDeg: number;
  stepHeight: number;
  speed: number;
}

export interface LandformGoal {
  id: string;
  name: string;
  description: string;
  relief: number;
  roughness: number;
  ridgeSharpness: number;
  basinDepth: number;
  riverIncision: number;
  palette: 'alpine' | 'arid' | 'karst';
}

export interface RidgeControl {
  id: string;
  points: Vec2[];
  height: number;
  width: number;
  /** >1 narrows the crest, <1 broadens it. */
  sharpness: number;
}

export interface BasinDefinition {
  id: string;
  name: string;
  center: Vec2;
  radius: number;
  floor: number;
  rim: number;
  /** Optional authored outline; when present it overrides the radial footprint. */
  points?: Vec2[];
}

export interface MustReachRegion {
  id: string;
  name: string;
  center: Vec2;
  radius: number;
  order: number;
  targetHeight?: number;
}

export interface PassDefinition {
  id: string;
  name: string;
  center: Vec2;
  radius: number;
}

export interface RiverDefinition {
  id: string;
  points: Vec2[];
  halfWidth: number;
  depth: number;
}

export interface LockState {
  riverbed: boolean;
  pass: boolean;
}

export type RepairKind = 'none' | 'reroute-trail' | 'raise-pass' | 'rollback';

export interface LevelSpec {
  seed: number;
  size: number;
  resolution: number;
  landform: LandformGoal;
  character: CharacterSpec;
  ridges: RidgeControl[];
  basins: BasinDefinition[];
  regions: MustReachRegion[];
  pass: PassDefinition;
  /** A natural dry col used when the hiking corridor must leave the river gorge. */
  dryCol?: PassDefinition;
  river: RiverDefinition;
  corridor: {
    width: number;
    shoulder: number;
    waypoints: Vec2[];
    /** Authored alternative alignment used when the hiking corridor must leave the pass. */
    detour?: Vec2[];
  };
  entrance: Vec2;
  locks: LockState;
  /** 0 = untouched, 1 = full incision at the pass. */
  erosion: number;
  repairPreference: 'auto' | 'reroute-trail' | 'raise-pass';
  precipitation: number;
}

export interface HeightFieldData {
  size: number;
  res: number;
  heights: Float32Array;
}

export interface TerrainDatum {
  /** Datum added to the whole map; frozen during local reshapes so distant ground keeps its level. */
  baseElev: number;
  /** Ridge contribution at a col; frozen alongside the datum. */
  sill: number;
}

/** The exact pipeline inputs a level was generated with, so a local reshape can replay it. */
export interface GenerationRecipe {
  riverPoints: Vec2[];
  route: Vec2[];
  protectRiverbed: boolean;
  raisePass: boolean;
  routeKind: 'initial' | 'rerouted' | 'restored';
}

export interface ReshapeBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ReshapeBlockReport {
  bx: number;
  bz: number;
  changedCells: number;
  totalCells: number;
  maxDelta: number;
  mode: 'patched' | 'frozen';
}

export interface SeamReport {
  boundaryCells: number;
  maxStep: number;
  meanStep: number;
  maxSlopeDeg: number;
  /** Agreement between the fine and coarse edit deltas (multi-scale consistency). */
  lodDeltaAgreement: number;
  ok: boolean;
}

export interface AdjustableRange {
  parameter: 'editScale' | 'corridorWidth' | 'ridgeOffset' | 'ridgeHeight' | 'passRadius';
  label: string;
  min: number;
  max: number;
  current: number;
  suggested: number;
  unit: string;
  note: string;
}

export interface ReshapeConflict {
  id: string;
  kind: 'unreachable-region' | 'no-ramp' | 'seam' | 'lod' | 'locked';
  label: string;
  detail: string;
  adjustable: AdjustableRange[];
}

export interface ReshapeRouteDiff {
  regionId: string;
  name: string;
  reachedBefore: boolean;
  reachedAfter: boolean;
  maxGradeBefore: number;
  maxGradeAfter: number;
  lengthBefore: number;
  lengthAfter: number;
  changed: boolean;
}

export interface ReshapeControlReport {
  status: LevelStatus;
  maxGrade: number;
  minNetWidth: number;
  maxFieldDelta: number;
  meanFieldDelta: number;
  elapsedMs: number;
}

export interface ReshapeReport {
  label: string;
  mode: 'local' | 'rolled-back';
  bounds: ReshapeBounds | null;
  blocks: ReshapeBlockReport[];
  blockCount: number;
  patchedCells: number;
  frozenCells: number;
  totalCells: number;
  affected: {
    ridges: string[];
    basins: string[];
    regions: string[];
    river: boolean;
    corridor: boolean;
    pass: boolean;
    hydrology: boolean;
    navigation: boolean;
  };
  routes: ReshapeRouteDiff[];
  corridorRoute: {
    changed: boolean;
    maxGradeBefore: number;
    maxGradeAfter: number;
    minWidthBefore: number;
    minWidthAfter: number;
  };
  seam: SeamReport;
  lod: { coarseRes: number; fineRes: number; deltaAgreement: number; finalAgreement: number };
  coarseGate: { accepted: boolean; reasons: string[] };
  fineGate: { accepted: boolean; reasons: string[] };
  conflicts: ReshapeConflict[];
  rolledBack: boolean;
  elapsedMs: number;
  patchMs: number;
  navigation: { field: 'fine'; res: number; corridorWalkSuccess: boolean; regionsReached: number };
  collision: { res: number; grid: 'bilinear'; changedCells: number };
  fullControl?: ReshapeControlReport;
  messages: string[];
}

export interface ReshapeOptions {
  previous: PlayableSnapshot;
  spec: LevelSpec;
  label?: string;
  blockCount?: number;
  /** Expand the work window about the change centre (>1 recomputes more surrounding slope). */
  editScale?: number;
  /** Run a full one-shot build on the same constrained spec as a comparison control. */
  runFullControl?: boolean;
  /** Reuse an already computed full-control field (avoids paying for it twice in the UI). */
  fullControl?: GenerationResult | null;
}

export interface CorridorSample {
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** Graded bench elevation. */
  h: number;
  base: number;
  grade: number;
  netWidth: number;
  waterHalfWidth: number;
  distanceToRiver: number;
  cut: number;
  fill: number;
}

export interface CorridorData {
  samples: CorridorSample[];
  width: number;
  shoulder: number;
  length: number;
  maxGrade: number;
  minNetWidth: number;
  passSampleIndex: number;
  routeKind: 'initial' | 'rerouted' | 'restored';
  disturbedFraction: number;
  cutVolume: number;
  fillVolume: number;
}

export interface WalkPoint {
  x: number;
  z: number;
  y: number;
  t: number;
  grade: number;
  clearance: number;
}

export interface WalkTrace {
  id: string;
  label: string;
  points: WalkPoint[];
  success: boolean;
  violations: string[];
  duration: number;
  length: number;
  maxGrade: number;
  minClearance: number;
  endDistance: number;
}

export interface RegionWalk extends WalkTrace {
  regionId: string;
  reached: boolean;
}

export interface RainParticleTrace {
  points: Vec2[];
  reached: boolean;
  seconds: number;
  /** Where the droplet ended up: drained to the outlet, stored in a basin, or lost in a puddle. */
  outcome?: 'reached' | 'stored' | 'blocked' | 'sink';
}

export interface RainResult {
  particles: number;
  reachedOutlet: number;
  ratio: number;
  /** Catchment immediately upstream of the pass, used to prove runoff was reconnected. */
  passRatio: number;
  passParticles: number;
  passReached: number;
  sinks: number;
  blocked: number;
  basinStorage: number;
  outOfBounds: number;
  maxPoolDepth: number;
  traces: RainParticleTrace[];
  /** Runoff from the pass catchment — the evidence that the saddle drains downstream. */
  passTraces: RainParticleTrace[];
  outlet: Vec2;
  success: boolean;
  summary: string;
}

export interface SlopeHistogramBin {
  from: number;
  to: number;
  fraction: number;
}

export interface RegionLandmark {
  id: string;
  name: string;
  center: Vec2;
  radius: number;
  order: number;
  /** Height the author wants at the landmark centre. */
  target: number;
  /** Mean relief within the landmark footprint. */
  relief: number;
}

export interface PassWidthInfo {
  width: number;
  forgiveness: number;
  reference: Vec2;
}

export interface GenerationMetrics {
  maxGrade: number;
  minNetWidth: number;
  requiredWidth: number;
  gradeViolations: number;
  widthViolations: number;
  passNetWidth: number;
  passForgiveness: number;
  ridgeFidelity: number;
  basinFidelity: number;
  regionFidelity: number;
  featureScore: number;
  travelScore: number;
  disturbance: number;
  cutVolume: number;
  fillVolume: number;
  flattenFraction: number;
  generationError: number;
  slopeHistogram: SlopeHistogramBin[];
  corridorLength: number;
  corridorDeviation: number;
  medianSlopeDeg: number;
}

export interface RepairCandidateReport {
  kind: RepairKind;
  allowed: boolean;
  feasible: boolean;
  traversalCost: number;
  disturbance: number;
  minNetWidth: number;
  maxGrade: number;
  note: string;
}

export interface RepairReport {
  chosen: RepairKind;
  reason: string;
  candidates: RepairCandidateReport[];
  riverRerouted: boolean;
  passMoved: boolean;
  rollback: boolean;
  previousLabel?: string;
}

export interface RegionStatus {
  id: string;
  name: string;
  reachable: boolean;
  distance: number;
  target: Vec2;
  actualHeight: number;
  targetHeight: number;
}

export interface Evaluation {
  accepted: boolean;
  reasons: string[];
  featureScore: number;
  travelScore: number;
  jointScore: number;
}

export type LevelStatus = 'ok' | 'repaired' | 'rolled-back' | 'failed';

export interface GenerationResult {
  spec: LevelSpec;
  field: HeightFieldData;
  water: Uint8Array;
  riverPath: Vec2[];
  riverHalfWidth: number;
  riverWaterLevel: number;
  corridor: CorridorData | null;
  landmarks: RegionLandmark[];
  pass: PassDefinition;
  passWidth: PassWidthInfo;
  metrics: GenerationMetrics;
  errorMap: Float32Array;
  walk: RegionWalk[];
  corridorWalk: WalkTrace | null;
  rain: RainResult;
  repair: RepairReport;
  evaluation: Evaluation;
  status: LevelStatus;
  messages: string[];
  elapsedMs: number;
  baseField: Float32Array;
  passCenter: Vec2;
  locks: LockState;
  snapshotLabel?: string;
  /** Replayable pipeline inputs, required to patch this level locally later. */
  recipe?: GenerationRecipe;
  datum?: TerrainDatum;
  hydrology?: import('./hydrology').Hydrology;
  reshape?: ReshapeReport | null;
}

export interface PlayableSnapshot {
  label: string;
  spec: LevelSpec;
  field: HeightFieldData;
  water: Uint8Array;
  riverPath: Vec2[];
  riverHalfWidth: number;
  riverWaterLevel: number;
  corridor: CorridorData;
  landmarks: RegionLandmark[];
  metrics: GenerationMetrics;
  walk: RegionWalk[];
  corridorWalk: WalkTrace;
  rain: RainResult;
  evaluation: Evaluation;
  errorMap: Float32Array;
  baseField: Float32Array;
  passCenter: Vec2;
  passWidth: PassWidthInfo;
  recipe?: GenerationRecipe;
  datum?: TerrainDatum;
  /** Water state of the fine mesh, needed so a later local patch can reuse it. */
  hydrology?: import('./hydrology').Hydrology;
}

export interface LevelPackage {
  format: 'ridgeline.level';
  version: 1;
  seed: number;
  size: number;
  resolution: number;
  character: CharacterSpec;
  heights: number[];
  water: number[];
  spec: LevelSpec;
  collision: {
    grid: 'bilinear';
    requiredWidth: number;
    maxSlopeDeg: number;
    stepHeight: number;
  };
  navigation: {
    corridor: { x: number; z: number; y: number }[];
    regions: { id: string; path: { x: number; z: number; y: number }[]; reached: boolean }[];
  };
  metrics: GenerationMetrics;
  status: LevelStatus;
}

export interface GenerationOptions {
  previous?: PlayableSnapshot | null;
  skipErosion?: boolean;
}
