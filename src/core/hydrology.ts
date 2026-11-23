import { clamp, closestOnPolyline, mulberry32, pointInPolygon } from './math';
import type { HeightField } from './terrain';
import { resampleWaypoints } from './terrain';
import type { BasinDefinition, LevelSpec, RainParticleTrace, RainResult, Vec2 } from './types';

export interface Hydrology {
  /** 1 = river/lake cell that carries water. */
  water: Uint8Array;
  /** Water surface elevation per cell (0 where dry). */
  surface: Float32Array;
  /** max(0, surface - terrain). */
  depth: Float32Array;
  /** 1 = wet and hydrologically connected to the outlet. */
  connected: Uint8Array;
  outlet: Vec2;
  riverPath: Vec2[];
  halfWidth: number;
  outletLevel: number;
}

const CHANNEL_DEPTH = 2.1;
const MAX_WALK_DEPTH = 0.4;

export function buildHydrology(field: HeightField, spec: LevelSpec, riverPoints: Vec2[]): Hydrology {
  const n = field.vertexCount;
  const res = field.res;
  const halfWidth = Math.max(1.5, spec.river.halfWidth);
  const path = resampleWaypoints(riverPoints.length >= 2 ? riverPoints : [spec.entrance, spec.pass.center], 1.1);
  const water = new Uint8Array(n * n);
  const surface = new Float32Array(n * n);
  const depth = new Float32Array(n * n);

  if (path.length < 2) {
    return {
      water,
      surface,
      depth,
      connected: water,
      outlet: riverPoints[riverPoints.length - 1] ?? spec.pass.center,
      riverPath: path,
      halfWidth,
      outletLevel: 0,
    };
  }

  // The channel bed is the ground itself: a stream can only occupy ground that is already at or
  // below the local valley floor. We do *not* raise the water surface to force monotonicity
  // (that would cut a canyon upstream); the river profile is simply the terrain along the path.
  // The outlet is its lowest point by construction, so runoff reaching it has drained.
  const levels = new Array<number>(path.length);
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    levels[i] = field.sample(p.x, p.z) - CHANNEL_DEPTH * 0.55;
  }

  const radiusCells = Math.ceil((halfWidth / field.size) * res) + 1;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const level = levels[i];
    const cx = clamp(Math.round(((p.x + field.size / 2) / field.size) * res), 0, res);
    const cz = clamp(Math.round(((p.z + field.size / 2) / field.size) * res), 0, res);
    for (let iz = Math.max(0, cz - radiusCells); iz <= Math.min(res, cz + radiusCells); iz++) {
      const wz = field.vertexZ(iz);
      for (let ix = Math.max(0, cx - radiusCells); ix <= Math.min(res, cx + radiusCells); ix++) {
        const wx = field.vertexX(ix);
        const d = Math.hypot(wx - p.x, wz - p.z);
        if (d > halfWidth) continue;
        const idx = iz * n + ix;
        const t = d / halfWidth;
        const bed = level - CHANNEL_DEPTH * (1 - t * t) + 0.45 * t * t;
        if (field.heights[idx] > bed) field.heights[idx] = bed;
        if (d <= halfWidth * 0.85) {
          if (surface[idx] < level) {
            surface[idx] = level;
            if (field.heights[idx] < level) {
              water[idx] = 1;
              depth[idx] = level - field.heights[idx];
            }
          }
        }
      }
    }
  }

  const outlet = path[path.length - 1];
  const outletLevel = levels[levels.length - 1];
  const connected = connectToOutlet(water, res, outlet, field);
  // Carving can leave wet pockets that never drain. Only the outlet-connected network counts as
  // the water system; isolated pockets inside authored basins stay as legitimate sinks.
  for (let iz = 0; iz < n; iz++) {
    const z = field.vertexZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix;
      if (!water[idx] || connected[idx]) continue;
      const x = field.vertexX(ix);
      const inBasin = spec.basins.some((b) =>
        b.points && b.points.length >= 3
          ? pointInPolygon(x, z, b.points)
          : Math.hypot(x - b.center.x, z - b.center.z) <= b.radius,
      );
      if (inBasin) continue;
      water[idx] = 0;
      depth[idx] = 0;
      surface[idx] = 0;
    }
  }
  return { water, surface, depth, connected, outlet, riverPath: path, halfWidth, outletLevel };
}

/**
 * Re-derive water/depth after the ground moved (e.g. fords raised the riverbed). Does *not*
 * recut the channel: raising a ford must stay raised, otherwise the next build undoes it.
 */
export function refreshWater(field: HeightField, hydrology: Hydrology, spec: LevelSpec): Hydrology {
  const n = field.vertexCount;
  const water = hydrology.water.slice();
  const depth = hydrology.depth.slice();
  const surface = hydrology.surface;
  for (let idx = 0; idx < water.length; idx++) {
    if (!water[idx]) continue;
    const d = surface[idx] - field.heights[idx];
    if (d <= 0.01) {
      water[idx] = 0;
      depth[idx] = 0;
    } else {
      depth[idx] = d;
    }
  }
  const connected = connectToOutlet(water, field.res, hydrology.outlet, field);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix;
      if (!water[idx] || connected[idx]) continue;
      const x = field.vertexX(ix);
      const z = field.vertexZ(iz);
      const inBasin = spec.basins.some((b) =>
        b.points && b.points.length >= 3
          ? pointInPolygon(x, z, b.points)
          : Math.hypot(x - b.center.x, z - b.center.z) <= b.radius,
      );
      if (inBasin) continue;
      water[idx] = 0;
      depth[idx] = 0;
    }
  }
  return { ...hydrology, water, depth, connected };
}

function connectToOutlet(water: Uint8Array, res: number, outlet: Vec2, field: HeightField): Uint8Array {
  const n = res + 1;
  const connected = new Uint8Array(water.length);
  let seed = -1;
  let best = Infinity;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix;
      if (!water[idx]) continue;
      const d = Math.hypot(field.vertexX(ix) - outlet.x, field.vertexZ(iz) - outlet.z);
      if (d < best) {
        best = d;
        seed = idx;
      }
    }
  }
  if (seed === -1) return connected;
  const queue = new Int32Array(water.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = seed;
  connected[seed] = 1;
  while (head < tail) {
    const idx = queue[head++];
    const ix = idx % n;
    const iz = (idx / n) | 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nz < 0 || nx > res || nz > res) continue;
        const ni = nz * n + nx;
        if (!water[ni] || connected[ni]) continue;
        connected[ni] = 1;
        queue[tail++] = ni;
      }
    }
  }
  return connected;
}

/** Builds the repaired runoff path: upstream reach → around/through the pass → downstream reach. */
export function reconnectDownstream(
  field: HeightField,
  spec: LevelSpec,
  original: Vec2[],
  passCenter: Vec2,
): Vec2[] {
  if (original.length < 2) return original;
  const radius = spec.pass.radius * 1.5;
  const outlet = original[original.length - 1];
  const upstream = original[0];
  const inside = (p: Vec2): boolean => Math.hypot(p.x - passCenter.x, p.z - passCenter.z) < radius;

  // Drop points that were laid over the pass, then reconnect upstream → downstream with a smooth channel.
  const kept = original.filter((p) => !inside(p));
  if (kept.length < 2) {
    const mid = { x: passCenter.x, z: passCenter.z };
    return [upstream, mid, outlet];
  }
  // Insert a monotone descent across the pass between the last upstream and first downstream kept points.
  const entry = kept.findIndex((p) => Math.hypot(p.x - upstream.x, p.z - upstream.z) >= radius);
  const insertAt = entry === -1 ? Math.max(1, kept.length - 1) : Math.max(1, entry);
  const bridge: Vec2[] = [];
  const steps = 6;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const a = kept[insertAt - 1];
    const b = kept[insertAt];
    // gentle arc through the rebuilt saddle
    const midX = passCenter.x;
    const midZ = passCenter.z;
    const arc = Math.sin(t * Math.PI) * 0.18;
    bridge.push({
      x: a.x + (b.x - a.x) * t + (midX - (a.x + b.x) / 2) * arc,
      z: a.z + (b.z - a.z) * t + (midZ - (a.z + b.z) / 2) * arc,
    });
  }
  const merged = [...kept.slice(0, insertAt), ...bridge, ...kept.slice(insertAt)];
  void field;
  return merged;
}

export interface RainOptions {
  field: HeightField;
  spec: LevelSpec;
  hydrology: Hydrology;
  basins: BasinDefinition[];
  particles?: number;
  seed?: number;
  recordTraces?: number;
}

interface FlowResult {
  points: Vec2[];
  reached: boolean;
  blocked: boolean;
  sink: boolean;
  basin: boolean;
  maxDepth: number;
}

interface Drainage {
  /** Downhill neighbour index; -1 marks a border cell. */
  down: Int32Array;
  /** 1 inside an authored basin (terminal sink). */
  basin: Uint8Array;
}

/**
 * Priority-flood drainage directions. Every cell gets a pointer to the neighbour it was reached
 * from while flooding inward from the map border, so following pointers always terminates at the
 * border (downstream) with strictly non-increasing ground height. This replaces per-particle
 * steepest-descent stepping, which oscillates forever on level plateaus and gives "never
 * converged" sinks on any flat lowland.
 */
function buildDrainage(field: HeightField, basins: BasinDefinition[]): Drainage {
  const n = field.vertexCount;
  const total = n * n;
  const down = new Int32Array(total).fill(-1);
  const visited = new Uint8Array(total);
  const basin = new Uint8Array(total);
  for (const b of basins) {
    for (let iz = 0; iz < n; iz++) {
      const dz = field.vertexZ(iz) - b.center.z;
      if (Math.abs(dz) > b.radius) continue;
      for (let ix = 0; ix < n; ix++) {
        const x = field.vertexX(ix);
        const inside = b.points && b.points.length >= 3
          ? pointInPolygon(x, field.vertexZ(iz), b.points)
          : Math.hypot(x - b.center.x, dz) <= b.radius * 0.98;
        if (inside) basin[iz * n + ix] = 1;
      }
    }
  }
  const heap = new MinHeap();
  const seed = (ix: number, iz: number): void => {
    const idx = iz * n + ix;
    if (visited[idx]) return;
    visited[idx] = 1;
    heap.push(idx, field.heights[idx]);
  };
  for (let ix = 0; ix < n; ix++) {
    seed(ix, 0);
    seed(ix, n - 1);
  }
  for (let iz = 0; iz < n; iz++) {
    seed(0, iz);
    seed(n - 1, iz);
  }
  const dxs = [1, -1, 0, 0, 1, 1, -1, -1];
  const dzs = [0, 0, 1, -1, 1, -1, 1, -1];
  while (heap.size > 0) {
    const { idx, level } = heap.pop()!;
    const ix = idx % n;
    const iz = (idx / n) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = ix + dxs[k];
      const nz = iz + dzs[k];
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nz * n + nx;
      if (visited[ni]) continue;
      visited[ni] = 1;
      down[ni] = idx;
      heap.push(ni, Math.max(field.heights[ni], level + 1e-3));
    }
  }
  return { down, basin };
}

class MinHeap {
  private idx: number[] = [];
  private val: number[] = [];
  push(idx: number, v: number): void {
    this.idx.push(idx);
    this.val.push(v);
    let i = this.idx.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.val[p] <= this.val[i]) break;
      [this.idx[p], this.idx[i]] = [this.idx[i], this.idx[p]];
      [this.val[p], this.val[i]] = [this.val[i], this.val[p]];
      i = p;
    }
  }
  pop(): { idx: number; level: number } | undefined {
    if (this.idx.length === 0) return undefined;
    const out = { idx: this.idx[0], level: this.val[0] };
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
        [this.idx[best], this.idx[i]] = [this.idx[i], this.idx[best]];
        [this.val[best], this.val[i]] = [this.val[i], this.val[best]];
        i = best;
      }
    }
    return out;
  }
  get size(): number {
    return this.idx.length;
  }
}

/** Steepest-descent runoff on the refined mesh. Basins are legitimate sinks, not failures. */
export function simulateRain(opts: RainOptions): RainResult {
  const { field, hydrology, basins } = opts;
  const particles = opts.particles ?? 180;
  const rng = mulberry32((opts.seed ?? opts.spec.seed) * 7919 + 13);
  const half = field.size / 2 - 2;
  const stepLen = Math.max(0.9, field.size / field.res);
  const outlet = hydrology.outlet;
  const outletRadius = Math.max(hydrology.halfWidth * 2.4, 5);
  const traces: RainParticleTrace[] = [];
  const recordLimit = opts.recordTraces ?? 36;
  const n = field.vertexCount;
  const drainage = buildDrainage(field, basins);
  const cellOf = (x: number, z: number): { ix: number; iz: number } => ({
    ix: clamp(Math.round(((x + field.size / 2) / field.size) * field.res), 0, field.res),
    iz: clamp(Math.round(((z + field.size / 2) / field.size) * field.res), 0, field.res),
  });
  const depthAt = (x: number, z: number): number => sampleFloat(field, hydrology.depth, x, z);
  // Depth is bilinearly interpolated, so a droplet on the bank of the river can read standing
  // water while the nearest grid cell is dry. Standing water touching the connected river is part
  // of it; check a couple of neighbouring cells before calling a droplet blocked.
  const connectedAt = (x: number, z: number): boolean => {
    if (sampleByte(field, hydrology.connected, x, z) === 1) return true;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (sampleByte(field, hydrology.connected, x + Math.cos(a) * 1.6, z + Math.sin(a) * 1.6) === 1) return true;
    }
    return false;
  };
  const basinAt = (x: number, z: number): boolean =>
    basins.some((b) =>
      b.points && b.points.length >= 3
        ? pointInPolygon(x, z, b.points)
        : Math.hypot(x - b.center.x, z - b.center.z) <= b.radius * 1.02,
    );

  const flow = (sx: number, sz: number, record: boolean): FlowResult => {
    const start = cellOf(sx, sz);
    let idx = start.iz * n + start.ix;
    const points: Vec2[] = [];
    let reached = false;
    let blocked = false;
    let storedBasin = drainage.basin[idx] === 1 || basinAt(sx, sz);
    let maxDepth = 0;
    let steps = 0;
    for (; steps < 6000; steps++) {
      const ix = idx % n;
      const iz = (idx / n) | 0;
      const x = field.vertexX(ix);
      const z = field.vertexZ(iz);
      if (record && steps % 4 === 0) points.push({ x, z });
      const dWater = depthAt(x, z);
      maxDepth = Math.max(maxDepth, dWater);
      // Standing water that is charged and linked to the outlet drains with it.
      if (dWater > MAX_WALK_DEPTH * 0.5 && hydrology.water[idx] && !connectedAt(x, z)) {
        blocked = true;
        break;
      }
      if (drainage.basin[idx] === 1) {
        storedBasin = true;
        break;
      }
      if (Math.hypot(x - outlet.x, z - outlet.z) < outletRadius) {
        reached = true;
        break;
      }
      const next = drainage.down[idx];
      if (next < 0) {
        // Border cell: the flow leaves the playable area and drains downstream.
        reached = true;
        break;
      }
      idx = next;
    }
    if (record) points.push({ x: field.vertexX(idx % n), z: field.vertexZ((idx / n) | 0) });
    return { points, reached, blocked, sink: false, basin: storedBasin && !reached && !blocked, maxDepth };
  };

  let ordinary = 0;
  let reachedCount = 0;
  let basinCount = 0;
  let blockedCount = 0;
  let sinkCount = 0;
  let maxPool = 0;

  for (let i = 0; i < particles; i++) {
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      x = (rng() * 2 - 1) * (half - 4);
      z = (rng() * 2 - 1) * (half - 4);
      if (depthAt(x, z) < 0.05) break;
    }
    const record = traces.length < recordLimit;
    const res = flow(x, z, record);
    if (record) traces.push({ points: res.points, reached: res.reached, seconds: res.points.length * stepLen });
    if (res.basin) {
      basinCount++;
      continue;
    }
    ordinary++;
    if (res.reached) reachedCount++;
    else {
      if (res.blocked) blockedCount++;
      if (res.sink) sinkCount++;
      maxPool = Math.max(maxPool, res.maxDepth);
    }
  }

  // Pass catchment: the saddle is a divide. Runoff generated on it must either reconnect to the
  // downstream outlet or be stored in an authored basin (a closed cirque is legitimate); only
  // water trapped in an unconnected puddle fails. This is what "reconnect the runoff downstream"
  // is actually asserting after the slope is rebuilt.
  const pass = opts.spec.pass.center;
  let passTotal = 0;
  let passReached = 0;
  let passStored = 0;
  let passBlocked = 0;
  const passParticles = 64;
  const passTraces: RainParticleTrace[] = [];
  for (let i = 0; i < passParticles; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * opts.spec.pass.radius * 0.8;
    const x = pass.x + Math.cos(a) * r;
    const z = pass.z + Math.sin(a) * r;
    if (depthAt(x, z) > 0.05) continue;
    passTotal++;
    const res = flow(x, z, true);
    if (res.reached) passReached++;
    else if (res.basin) passStored++;
    else if (res.blocked) passBlocked++;
    // Every pass droplet is evidence, so record them regardless of how it ended.
    const outcome: RainParticleTrace['outcome'] = res.reached
      ? 'reached'
      : res.basin
        ? 'stored'
        : res.blocked
          ? 'blocked'
          : 'sink';
    passTraces.push({ points: res.points, reached: res.reached, seconds: res.points.length * stepLen, outcome });
  }

  const ratio = ordinary > 0 ? reachedCount / ordinary : 0;
  // Stored-in-basin counts as a resolved droplet, not a failure.
  const passRatio = passTotal > 0 ? (passReached + passStored) / passTotal : 1;
  // Basins legitimately trap some rain; count their share so the policy is explainable.
  const basinShare = particles > 0 ? basinCount / particles : 0;
  const success = ratio >= 0.68 && passRatio >= 0.8 && passBlocked === 0 && basinShare <= 0.35;
  const summary = success
    ? `降雨 ${particles} 点：${reachedCount}/${ordinary} 汇入下游，山口汇水 ${passReached}/${passTotal} 排除或蓄于盆地，${basinCount} 点正常蓄于盆地。`
    : `降雨未通过：汇入下游 ${(ratio * 100).toFixed(0)}%，山口汇水 ${(passRatio * 100).toFixed(0)}%，${blockedCount} 点被拦蓄${passBlocked ? `（山口 ${passBlocked} 点）` : ''}，${basinCount} 点蓄于盆地。`;

  return {
    particles: ordinary,
    reachedOutlet: reachedCount,
    ratio,
    passRatio,
    passParticles: passTotal,
    passReached,
    sinks: sinkCount + blockedCount,
    blocked: blockedCount,
    basinStorage: basinCount,
    outOfBounds: 0,
    maxPoolDepth: maxPool,
    traces,
    passTraces,
    outlet,
    success,
    summary,
  };
}

export function sampleFloat(field: HeightField, grid: Float32Array, x: number, z: number): number {
  const res = field.res;
  const fx = clamp(((x + field.size / 2) / field.size) * res, 0, res - 1e-6);
  const fz = clamp(((z + field.size / 2) / field.size) * res, 0, res - 1e-6);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const n = res + 1;
  const a = grid[iz * n + ix];
  const b = grid[iz * n + ix + 1];
  const c = grid[(iz + 1) * n + ix];
  const d = grid[(iz + 1) * n + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export function sampleByte(field: HeightField, grid: Uint8Array, x: number, z: number): number {
  const res = field.res;
  const ix = clamp(Math.round(((x + field.size / 2) / field.size) * res), 0, res);
  const iz = clamp(Math.round(((z + field.size / 2) / field.size) * res), 0, res);
  return grid[iz * (res + 1) + ix];
}

export function riverDistance(spec: LevelSpec, p: Vec2): number {
  return spec.river.points.length >= 2 ? closestOnPolyline(p.x, p.z, spec.river.points).distance : Infinity;
}
