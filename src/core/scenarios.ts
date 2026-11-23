import type { LandformGoal, LevelSpec, Vec2 } from './types';

export const LANDFORMS: Record<'alpine' | 'arid' | 'karst', LandformGoal> = {
  alpine: {
    id: 'alpine',
    name: '高山冰蚀',
    description: '高起伏、锐利山脊与窄谷，主关卡的默认地貌。',
    relief: 74,
    roughness: 0.8,
    ridgeSharpness: 1.3,
    basinDepth: 0.95,
    riverIncision: 1,
    palette: 'alpine',
  },
  arid: {
    id: 'arid',
    name: '干旱台地',
    description: '缓起伏台地与宽浅河谷，坡面更均匀。',
    relief: 52,
    roughness: 0.5,
    ridgeSharpness: 0.8,
    basinDepth: 0.6,
    riverIncision: 0.7,
    palette: 'arid',
  },
  karst: {
    id: 'karst',
    name: '喀斯特溶蚀',
    description: '低山溶蚀盆地，山脊破碎，盆地占比大。',
    relief: 64,
    roughness: 0.7,
    ridgeSharpness: 1,
    basinDepth: 1.15,
    riverIncision: 0.85,
    palette: 'karst',
  },
};

export const SIZE = 440;
export const DEFAULT_RES = 180;
export const CHARACTER = { radius: 0.5, height: 1.8, maxSlopeDeg: 34, stepHeight: 0.45, speed: 2.2 };

export const ENTRANCE: Vec2 = { x: 95, z: 160 };
export const PASS_CENTER: Vec2 = { x: -20, z: 0 };
export const DRY_COL: Vec2 = { x: 82, z: 0 };

const ridgeLine: Vec2[] = [
  { x: -210, z: 24 },
  { x: -150, z: 16 },
  { x: -90, z: 10 },
  { x: -40, z: 4 },
  { x: 10, z: 2 },
  { x: 60, z: 0 },
  { x: 120, z: 4 },
  { x: 180, z: 14 },
  { x: 212, z: 22 },
];

export const BASE_SPEC: LevelSpec = {
  seed: 1701,
  size: SIZE,
  resolution: DEFAULT_RES,
  landform: LANDFORMS.alpine,
  character: CHARACTER,
  ridges: [{ id: 'main', points: ridgeLine, height: 58, width: 32, sharpness: 1.35 }],
  basins: [
    { id: 'north-basin', name: '北侧冰斗', center: { x: -92, z: -98 }, radius: 54, floor: 26, rim: 54 },
    { id: 'east-hollow', name: '东谷盆地', center: { x: 135, z: -66 }, radius: 46, floor: 28, rim: 50 },
  ],
  regions: [
    { id: 'ridge-lookout', name: '山脊瞭望台', center: { x: 98, z: 34 }, radius: 11, order: 1 },
    { id: 'east-hollow', name: '东谷盆地', center: { x: 135, z: -66 }, radius: 14, order: 2 },
    { id: 'north-basin', name: '北侧冰斗', center: { x: -84, z: -106 }, radius: 15, order: 3 },
  ],
  pass: { id: 'old-pass', name: '旧山口', center: PASS_CENTER, radius: 17 },
  dryCol: { id: 'dry-col', name: '干燥副垭口', center: DRY_COL, radius: 15 },
  river: {
    id: 'main-river',
    // A spring breaks at the old pass and drains south to the outlet; the northern cirque is a
    // closed basin that stores its own rain. So the pass is a genuinely *wet* crossing: the trail
    // fords the spring, and both lock policies act on the same broken stretch of ground.
    points: [
      { x: -20, z: 0 },
      { x: -17, z: 18 },
      { x: -10, z: 40 },
      { x: 1, z: 66 },
      { x: 8, z: 92 },
      { x: 12, z: 120 },
      { x: 14, z: 150 },
    ],
    halfWidth: 3.2,
    depth: 2.2,
  },
  // Authored trail: approaches the lookout through the southern lowland, crosses the ridge once
  // at the old pass, then works the northern side. Waypoints deliberately stay off the crest —
  // a trail that rides the ridgeline forces the bench up the 60° flanks.
  corridor: {
    width: 4.4,
    shoulder: 3,
    waypoints: [
      { x: 95, z: 160 },
      { x: 96, z: 112 },
      { x: 98, z: 34 },
      { x: 75, z: 30 },
      { x: 45, z: 32 },
      { x: 15, z: 28 },
      { x: -6, z: 20 },
      { x: -20, z: 0 },
      { x: -14, z: -24 },
      { x: 12, z: -42 },
      { x: 48, z: -56 },
      { x: 90, z: -64 },
      { x: 135, z: -66 },
      { x: 132, z: -92 },
      { x: 96, z: -118 },
      { x: 40, z: -126 },
      { x: -20, z: -124 },
      { x: -60, z: -116 },
      { x: -76, z: -108 },
      { x: -84, z: -106 },
    ],
    // When the riverbed is locked the trail must leave the wet gorge. This alignment crosses the
    // ridge at the dry col and then descends north-east into the basin, instead of looping west
    // and back — a "detour" that reuses the old approach and backtracks across the col.
    detour: [
      { x: 95, z: 160 },
      { x: 96, z: 112 },
      { x: 98, z: 34 },
      { x: 88, z: 16 },
      { x: 82, z: 0 },
      { x: 92, z: -22 },
      { x: 118, z: -44 },
      { x: 135, z: -66 },
      { x: 132, z: -92 },
      { x: 96, z: -118 },
      { x: 40, z: -126 },
      { x: -20, z: -124 },
      { x: -60, z: -116 },
      { x: -76, z: -108 },
      { x: -84, z: -106 },
    ],
  },
  entrance: { ...ENTRANCE },
  locks: { riverbed: false, pass: false },
  erosion: 0,
  repairPreference: 'auto',
  precipitation: 1,
};

/** The authored route that crosses the old pass (used when the pass is locked). */
export function oldPassWaypoints(spec: LevelSpec): Vec2[] {
  const pts = spec.corridor.waypoints.map((p) => ({ ...p }));
  // Insert the old-pass crossing between the ridge shoulder and the eastern basin.
  const insertAt = pts.findIndex((p) => Math.hypot(p.x - spec.dryCol!.center.x, p.z - spec.dryCol!.center.z) < 12);
  const crossing: Vec2[] = [
    { x: 48, z: 6 },
    { x: 8, z: 2 },
    { x: spec.pass.center.x, z: spec.pass.center.z },
    { x: -4, z: -22 },
    { x: 24, z: -40 },
  ];
  if (insertAt >= 0) pts.splice(insertAt, 0, ...crossing);
  else pts.splice(3, 0, ...crossing);
  return pts;
}

export function cloneSpec(spec: LevelSpec): LevelSpec {
  return {
    ...spec,
    landform: { ...spec.landform },
    character: { ...spec.character },
    ridges: spec.ridges.map((r) => ({ ...r, points: r.points.map((p) => ({ ...p })) })),
    basins: spec.basins.map((b) => ({ ...b, center: { ...b.center }, points: b.points?.map((p) => ({ ...p })) })),
    regions: spec.regions.map((r) => ({ ...r, center: { ...r.center } })),
    pass: { ...spec.pass, center: { ...spec.pass.center } },
    dryCol: spec.dryCol ? { ...spec.dryCol, center: { ...spec.dryCol.center } } : undefined,
    river: { ...spec.river, points: spec.river.points.map((p) => ({ ...p })) },
    corridor: { ...spec.corridor, waypoints: spec.corridor.waypoints.map((p) => ({ ...p })), detour: spec.corridor.detour?.map((p) => ({ ...p })) },
    entrance: { ...spec.entrance },
    locks: { ...spec.locks },
  };
}

/** Corridor alignment through the dry col instead of the river gorge. */
export function dryColWaypoints(spec: LevelSpec): Vec2[] {
  const col = spec.dryCol?.center ?? { x: 82, z: 0 };
  const notch: Vec2[] = [];
  for (const p of spec.corridor.waypoints) {
    if (Math.hypot(p.x - spec.pass.center.x, p.z - spec.pass.center.z) < spec.pass.radius * 1.35) continue;
    notch.push({ ...p });
  }
  // Insert the dry-col crossing between the ridge-shoulder region and the northern traverses.
  const insertAt = Math.max(2, Math.min(notch.length - 1, 3));
  const approach = [
    { x: col.x + 4, z: col.z + 12 },
    { x: col.x, z: col.z },
    { x: col.x - 22, z: col.z - 18 },
  ];
  notch.splice(insertAt, 0, ...approach);
  return notch;
}

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
  expected: string;
  expectedStatus: 'ok' | 'repaired' | 'rolled-back' | 'failed';
  /** A clean map generated first and offered as the rollback target. */
  prerequisite?: () => LevelSpec;
  build: () => LevelSpec;
}

function makeScenario(
  id: string,
  name: string,
  blurb: string,
  expected: string,
  expectedStatus: Scenario['expectedStatus'],
  build: () => LevelSpec,
  prerequisite?: () => LevelSpec,
): Scenario {
  return { id, name, blurb, expected, expectedStatus, build, prerequisite };
}

const cleanMap = (): LevelSpec => {
  const s = cloneSpec(BASE_SPEC);
  s.seed = 2411;
  s.locks = { riverbed: false, pass: false };
  s.erosion = 0;
  return s;
};

export const SCENARIOS: Scenario[] = [
  makeScenario(
    'broken-river-lock',
    '断口 · 保水系',
    '侵蚀河谷在旧山口切断了步道。河床被锁死：水系、河道与出水口保持原位，只能把登山走廊移离河谷。',
    '步道改走干燥副垭口，旧河道与山口水系保持原位，角色与降雨验收通过。',
    'repaired',
    () => {
      const s = cleanMap();
      s.locks = { riverbed: true, pass: false };
      s.erosion = 0.42;
      return s;
    },
    cleanMap,
  ),
  makeScenario(
    'broken-pass-lock',
    '断口 · 保旧山口',
    '同一处断口，但这次锁住旧山口：步道必须仍从旧山口通过。修补时填高被切开的坡面，并把上游径流改道、重新接回下游。',
    '旧山口恢复为可通行鞍部，山口汇水仍能接回下游，河床允许改道。',
    'repaired',
    () => {
      const s = cleanMap();
      s.locks = { riverbed: false, pass: true };
      s.erosion = 0.42;
      return s;
    },
    cleanMap,
  ),
  makeScenario(
    'contradiction',
    '双锁 · 矛盾约束',
    '同一处断口同时锁死河床与唯一山口。步道被钉在旧山口的河道上，既不能移动走廊也不能改水系，净宽无解。',
    '不生成新地图，保留上一张能通关的地图并给出冲突原因。',
    'rolled-back',
    () => {
      const s = cleanMap();
      s.locks = { riverbed: true, pass: true };
      s.erosion = 0.42;
      return s;
    },
    cleanMap,
  ),
  makeScenario(
    'gentle-valley',
    '缓坡台地',
    '干旱台地地貌，坡面均缓；无断口。检查坡度直方图与入口到三处必达区的实际行走。',
    '无需修补，三条角色路线全部抵达，地貌保持台地形态。',
    'ok',
    () => {
      const s = cleanMap();
      s.seed = 90210;
      s.landform = LANDFORMS.arid;
      return s;
    },
  ),
  makeScenario(
    'karst-basins',
    '喀斯特盆地',
    '溶蚀盆地占比高的地貌，必达区分散三向。检查盆地保真、走廊过渡与降雨蓄水。',
    '盆地与山脊特征分数达标，角色分别进入三处必达区。',
    'ok',
    () => {
      const s = cleanMap();
      s.seed = 7717;
      s.landform = LANDFORMS.karst;
      s.erosion = 0.06;
      s.basins[0] = { ...s.basins[0], radius: 62 };
      s.basins[1] = { ...s.basins[1], radius: 52 };
      return s;
    },
  ),
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export interface DemoState {
  scenarioId: string;
  seed: number;
  erosion: number;
  locks: { riverbed: boolean; pass: boolean };
  resolution: number;
  landformId: 'alpine' | 'arid' | 'karst';
  repairPreference: 'auto' | 'reroute-trail' | 'raise-pass';
}

export function specFromState(state: DemoState): LevelSpec {
  const scenario = scenarioById(state.scenarioId);
  const spec = scenario ? scenario.build() : cloneSpec(BASE_SPEC);
  spec.seed = state.seed;
  spec.erosion = state.erosion;
  spec.locks = { ...state.locks };
  spec.resolution = state.resolution;
  spec.landform = LANDFORMS[state.landformId];
  spec.repairPreference = state.repairPreference;
  return spec;
}
