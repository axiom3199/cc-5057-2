import { clamp, percentile } from './math';
import type { HeightField } from './terrain';
import type { CorridorData, LevelSpec, MustReachRegion, RegionWalk, Vec2, WalkPoint, WalkTrace } from './types';

export interface NavGrid {
  field: HeightField;
  size: number;
  res: number;
  step: number;
  walkable: Uint8Array;
  clearance: Float32Array;
  waterDepth: Float32Array;
  slopeLimit: number;
  stepHeight: number;
  radius: number;
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export const MAX_WADE_DEPTH = 0.4;

export function navVertexX(nav: NavGrid, ix: number): number {
  return -nav.size / 2 + (ix / nav.res) * nav.size;
}

export function navVertexZ(nav: NavGrid, iz: number): number {
  return -nav.size / 2 + (iz / nav.res) * nav.size;
}

export function buildNavGrid(
  field: HeightField,
  spec: LevelSpec,
  _corridor: CorridorData | null,
  _waterLevel: number,
  hydrologyDepth?: Float32Array,
): NavGrid {
  const res = field.res;
  const n = res + 1;
  const nav: NavGrid = {
    field,
    size: field.size,
    res,
    step: field.size / res,
    walkable: new Uint8Array(n * n),
    clearance: new Float32Array(n * n),
    waterDepth: new Float32Array(n * n),
    slopeLimit: Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180),
    stepHeight: spec.character.stepHeight,
    radius: spec.character.radius,
  };
  const g = { h: 0, gx: 0, gz: 0 };
  void g;
  for (let iz = 0; iz < n; iz++) {
    const z = navVertexZ(nav, iz);
    for (let ix = 0; ix < n; ix++) {
      const x = navVertexX(nav, ix);
      const idx = iz * n + ix;
      const depth = hydrologyDepth ? sampleDepth(hydrologyDepth, field, x, z) : 0;
      const clear = discClearance(field, x, z, spec.character.radius, nav.slopeLimit, spec.character.stepHeight, hydrologyDepth);
      nav.clearance[idx] = clear;
      nav.waterDepth[idx] = depth;
      // Grid cells pass if the character disc fits and the cell itself is not waterlogged.
      nav.walkable[idx] = clear >= spec.character.radius * 1.6 && depth <= MAX_WADE_DEPTH ? 1 : 0;
    }
  }
  return nav;
}

export function sampleDepth(grid: Float32Array, field: HeightField, x: number, z: number): number {
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

/**
 * The largest free radius around (x,z): terrain stays within the step envelope,
 * slopes stay under the limit and water stays shallow in every direction.
 */
export function discClearance(
  field: HeightField,
  x: number,
  z: number,
  maxRadius: number,
  slopeLimit: number,
  stepHeight: number,
  depthGrid?: Float32Array,
): number {
  const step = Math.max(0.4, field.size / field.res * 0.5);
  // Measure a genuine free radius, not just twice the character radius.
  const reach = Math.max(maxRadius * 2.6, 2.8);
  const hCenter = field.sample(x, z);
  if (depthGrid && sampleDepth(depthGrid, field, x, z) > MAX_WADE_DEPTH) return 0;
  let free = reach;
  const dirs = 12;
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let prev = hCenter;
    for (let d = step; d <= reach; d += step) {
      const qx = x + dx * d;
      const qz = z + dz * d;
      if (Math.abs(qx) > field.size / 2 - 1 || Math.abs(qz) > field.size / 2 - 1) {
        free = Math.min(free, d - step);
        break;
      }
      const h = field.sample(qx, qz);
      if (depthGrid && sampleDepth(depthGrid, field, qx, qz) > MAX_WADE_DEPTH) {
        free = Math.min(free, d - step);
        break;
      }
      // Step-wise grade is the constraint; a large disc is allowed to span a long ramp.
      if (Math.abs(h - prev) / step > slopeLimit * 1.05) {
        free = Math.min(free, d - step);
        break;
      }
      if (Math.abs(h - hCenter) > stepHeight * 1.5 + d * slopeLimit * 1.08) {
        free = Math.min(free, d - step);
        break;
      }
      prev = h;
    }
  }
  return free;
}

function idx3(nav: NavGrid, ix: number, iz: number): number {
  return iz * (nav.res + 1) + ix;
}

export interface PathResult {
  points: Vec2[];
  success: boolean;
}

export function findPath(
  nav: NavGrid,
  start: Vec2,
  goal: Vec2,
  opts: { bias?: Vec2[]; allowPartial?: boolean } = {},
): PathResult {
  const W = nav.res + 1;
  const total = W * W;
  const s = snapToWalkable(nav, start, 18);
  const t = snapToWalkable(nav, goal, 22);
  if (!s || !t) return { points: [], success: false };
  const startIdx = idx3(nav, s.ix, s.iz);
  const goalIdx = idx3(nav, t.ix, t.iz);
  if (startIdx === goalIdx) return { points: [start, goal], success: true };
  const gScore = new Float32Array(total).fill(Infinity);
  const came = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const open = new BinaryHeap();
  gScore[startIdx] = 0;
  open.push({ idx: startIdx, f: heuristic(s.ix, s.iz, t.ix, t.iz), g: 0 });
  const bias = opts.bias && opts.bias.length > 1 ? buildBias(nav, opts.bias) : null;
  let iter = 0;
  const maxIter = total * 4;
  let bestIdx = startIdx;
  let bestH = Infinity;
  let found = false;

  while (open.size > 0 && iter++ < maxIter) {
    const cur = open.pop()!;
    if (closed[cur.idx]) continue;
    closed[cur.idx] = 1;
    if (cur.idx === goalIdx) {
      found = true;
      break;
    }
    const cx = cur.idx % W;
    const cz = (cur.idx / W) | 0;
    const hg = heuristic(cx, cz, t.ix, t.iz);
    if (hg < bestH) {
      bestH = hg;
      bestIdx = cur.idx;
    }
    for (const [dx, dz, w] of NEIGHBOURS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx > nav.res || nz > nav.res) continue;
      const ni = idx3(nav, nx, nz);
      if (closed[ni] || !nav.walkable[ni]) continue;
      if (dx !== 0 && dz !== 0) {
        if (!nav.walkable[idx3(nav, cx + dx, cz)] || !nav.walkable[idx3(nav, cx, cz + dz)]) continue;
      }
      const h0 = nav.field.sample(navVertexX(nav, cx), navVertexZ(nav, cz));
      const h1 = nav.field.sample(navVertexX(nav, nx), navVertexZ(nav, nz));
      const rise = h1 - h0;
      const run = nav.step * w;
      const grade = Math.abs(rise) / run;
      // Grade is the real constraint at grid scale; step height is checked at 0.5 m in profilePath.
      if (grade > nav.slopeLimit * 1.02) continue;
      let cost = run * (1 + (grade / nav.slopeLimit) ** 2 * 1.5);
      cost += nav.waterDepth[ni] * 8;
      cost += (1 - Math.min(1, nav.clearance[ni] / (nav.radius * 2.4))) * run * 1.4;
      // Prefer the authored trail: a designated corridor is the walkable route, so cutting the
      // inside of a switchback (onto ungraded cut-slope) must cost more than staying on it.
      if (bias) cost += bias[ni] * run * 3.2;
      const tentative = gScore[cur.idx] + cost;
      if (tentative < gScore[ni]) {
        gScore[ni] = tentative;
        came[ni] = cur.idx;
        open.push({ idx: ni, f: tentative + heuristic(nx, nz, t.ix, t.iz), g: tentative });
      }
    }
  }

  let endIdx = goalIdx;
  if (!found) {
    if (!opts.allowPartial) return { points: [], success: false };
    endIdx = bestIdx;
    if (endIdx === startIdx) return { points: [], success: false };
  }
  const pts: Vec2[] = [];
  let idx = endIdx;
  let guard = 0;
  while (idx !== -1 && guard++ < total) {
    pts.push({ x: navVertexX(nav, idx % W), z: navVertexZ(nav, (idx / W) | 0) });
    if (idx === startIdx) break;
    idx = came[idx];
  }
  pts.reverse();
  if (pts.length === 0) return { points: [], success: false };
  pts[0] = { ...start };
  if (found) pts[pts.length - 1] = { ...goal };
  return { points: pts, success: found };
}

function buildBias(nav: NavGrid, bias: Vec2[]): Float32Array {
  const W = nav.res + 1;
  const out = new Float32Array(W * W);
  for (let iz = 0; iz < W; iz++) {
    const z = navVertexZ(nav, iz);
    for (let ix = 0; ix < W; ix++) {
      const x = navVertexX(nav, ix);
      let best = Infinity;
      for (let i = 1; i < bias.length; i += Math.max(1, Math.floor(bias.length / 60))) {
        const d = (bias[i].x - x) ** 2 + (bias[i].z - z) ** 2;
        if (d < best) best = d;
      }
      out[iz * W + ix] = Math.min(Math.sqrt(best) / 22, 2.2);
    }
  }
  return out;
}

function snapToWalkable(nav: NavGrid, p: Vec2, maxCells: number): { ix: number; iz: number } | null {
  const ix = Math.round(((p.x + nav.size / 2) / nav.size) * nav.res);
  const iz = Math.round(((p.z + nav.size / 2) / nav.size) * nav.res);
  if (ix >= 0 && iz >= 0 && ix <= nav.res && iz <= nav.res && nav.walkable[idx3(nav, ix, iz)]) return { ix, iz };
  let best: { ix: number; iz: number } | null = null;
  let bestD = Infinity;
  for (let r = 1; r <= maxCells; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nz < 0 || nx > nav.res || nz > nav.res) continue;
        if (!nav.walkable[idx3(nav, nx, nz)]) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = { ix: nx, iz: nz };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

class BinaryHeap {
  private items: { idx: number; f: number; g: number }[] = [];
  push(v: { idx: number; f: number; g: number }): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { idx: number; f: number; g: number } | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < a.length && a[l].f < a[best].f) best = l;
        if (r < a.length && a[r].f < a[best].f) best = r;
        if (best === i) break;
        [a[best], a[i]] = [a[i], a[best]];
        i = best;
      }
    }
    return top;
  }
  get size(): number {
    return this.items.length;
  }
}

function heuristic(x: number, z: number, gx: number, gz: number): number {
  const dx = Math.abs(x - gx);
  const dz = Math.abs(z - gz);
  return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
}

export interface ProfilePoint {
  x: number;
  z: number;
  y: number;
  distance: number;
  grade: number;
  clearance: number;
}

export interface ProfileCheck {
  ok: boolean;
  violations: string[];
  points: ProfilePoint[];
  length: number;
  maxGrade: number;
  minClearance: number;
  minWidth: number;
}

/** 0.5 m resampling on the final mesh: grade, step, disc clearance and water depth. */
export function profilePath(
  points: Vec2[],
  field: HeightField,
  spec: LevelSpec,
  waterLevel: number,
  depthGrid?: Float32Array,
): ProfileCheck {
  const slopeLimit = Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180);
  const step = 0.5;
  const dense: Vec2[] = [];
  const spacing: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      dense.push(points[0]);
      spacing.push(0);
      continue;
    }
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const nSeg = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= nSeg; k++) {
      dense.push({ x: a.x + (b.x - a.x) * (k / nSeg), z: a.z + (b.z - a.z) * (k / nSeg) });
      spacing.push(len / nSeg);
    }
  }
  const violations: string[] = [];
  const profile: ProfilePoint[] = [];
  let length = 0;
  let maxGrade = 0;
  let minClearance = Infinity;
  let minWidth = Infinity;
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i];
    const y = field.sample(p.x, p.z);
    let grade = 0;
    if (i > 0) {
      const run = spacing[i] || 0.5;
      grade = Math.abs(y - profile[i - 1].y) / run;
      length += run;
      maxGrade = Math.max(maxGrade, grade);
      if (grade > slopeLimit * 1.03 && violations.length < 8) {
        violations.push(`坡度 ${((Math.atan(grade) * 180) / Math.PI).toFixed(1)}° 超过 ${spec.character.maxSlopeDeg}° @ (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
      }
      if (Math.abs(y - profile[i - 1].y) > spec.character.stepHeight && violations.length < 8) {
        violations.push(`高差台阶 ${Math.abs(y - profile[i - 1].y).toFixed(2)} m @ (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
      }
    }
    const clear = discClearance(field, p.x, p.z, spec.character.radius, slopeLimit, spec.character.stepHeight, depthGrid);
    minClearance = Math.min(minClearance, clear);
    minWidth = Math.min(minWidth, clear * 2);
    if (clear < spec.character.radius * 0.98 && violations.length < 8) {
      violations.push(`净宽不足 ${(clear * 2).toFixed(2)} m（角色直径 ${(spec.character.radius * 2).toFixed(2)} m）@ (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
    }
    if (depthGrid && sampleDepth(depthGrid, field, p.x, p.z) > MAX_WADE_DEPTH && violations.length < 8) {
      violations.push(`路线穿过深水 @ (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
    }
    profile.push({ x: p.x, z: p.z, y, distance: length, grade, clearance: clear });
  }
  void waterLevel;
  return {
    ok: violations.length === 0,
    violations,
    points: profile,
    length,
    maxGrade,
    minClearance: Number.isFinite(minClearance) ? minClearance : 0,
    minWidth: Number.isFinite(minWidth) ? minWidth : 0,
  };
}

export function segmentOk(a: Vec2, b: Vec2, field: HeightField, spec: LevelSpec, depth?: Float32Array): boolean {
  const slopeLimit = Math.tan((spec.character.maxSlopeDeg * Math.PI) / 180);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(2, Math.ceil(len / 0.6));
  const minClear = spec.character.radius * 0.98;
  let prev = field.sample(a.x, a.z);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const h = field.sample(x, z);
    const run = len / steps;
    if (Math.abs(h - prev) / run > slopeLimit * 1.03) return false;
    if (depth && sampleDepth(depth, field, x, z) > MAX_WADE_DEPTH) return false;
    // A shortcut must not cross a cliff; the disc has to fit the whole way.
    if (discClearance(field, x, z, spec.character.radius, slopeLimit, spec.character.stepHeight, depth) < minClear) return false;
    prev = h;
  }
  return true;
}

export function simplifyPath(points: Vec2[], field: HeightField, spec: LevelSpec, depth?: Float32Array): Vec2[] {
  if (points.length <= 2) return points;
  const out: Vec2[] = [points[0]];
  let anchor = 0;
  for (let i = 2; i < points.length; i++) {
    if (!segmentOk(points[anchor], points[i], field, spec, depth)) {
      out.push(points[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

export interface WalkPlan {
  walks: RegionWalk[];
  corridorWalk: WalkTrace | null;
  corridorRoute: Vec2[];
  regionRoutes: Map<string, Vec2[]>;
}

export function planAndWalk(
  nav: NavGrid,
  field: HeightField,
  spec: LevelSpec,
  regions: MustReachRegion[],
  corridor: CorridorData | null,
  waterLevel: number,
  depthGrid?: Float32Array,
): WalkPlan {
  const ordered = [...regions].sort((a, b) => a.order - b.order);
  const walks: RegionWalk[] = [];
  const regionRoutes = new Map<string, Vec2[]>();
  const corridorPath = corridor ? corridor.samples.map((s) => ({ x: s.x, z: s.z })) : null;

  for (const r of ordered) {
    // The authored trail is the designated route and is graded for the character. Walk it to the
    // corridor point nearest the region, then spur in with A*. Routing the whole walk with A* on
    // the raw grid lets diagonals cut across the bench's cut-slope (a 35° face one cell off the
    // trail), which fails on the fine mesh even though the trail itself is walkable.
    let route: Vec2[] = [];
    if (corridorPath && corridorPath.length > 1) {
      const nearest = nearestPointIndex(corridorPath, r.center);
      route = corridorPath.slice(0, nearest + 1).map((p) => ({ ...p }));
      const spur = findPath(nav, route[route.length - 1], r.center, { allowPartial: true });
      if (spur.points.length > 1) route.push(...spur.points.slice(1));
    } else {
      route = findPath(nav, spec.entrance, r.center, { allowPartial: false }).points;
    }
    const target = route[route.length - 1] ?? spec.entrance;
    if (Math.hypot(target.x - r.center.x, target.z - r.center.z) > Math.max(r.radius * 0.5, 1.5)) {
      route = findPath(nav, spec.entrance, r.center, { bias: corridorPath ?? undefined, allowPartial: false }).points;
    }
    // Simplifying can cut a corner tighter than the 0.6 m segment audit sees; fall back to the
    // raw (0.5 m-spaced) route when the simplified one fails the profile.
    let best = route.length > 1 ? profilePath(route, field, spec, waterLevel, depthGrid) : emptyProfile();
    let bestRoute = route;
    if (route.length > 2) {
      const simp = simplifyPath(route, field, spec, depthGrid);
      const simpProf = profilePath(simp, field, spec, waterLevel, depthGrid);
      if (simpProf.ok || (!best.ok && simpProf.violations.length <= best.violations.length)) {
        best = simpProf;
        bestRoute = simp;
      }
    }
    if (!best.ok) {
      const alt = findPath(nav, spec.entrance, r.center, { allowPartial: false });
      if (alt.success) {
        const altRaw = alt.points;
        const altRoute = simplifyPath(altRaw, field, spec, depthGrid);
        const altProf = profilePath(altRoute, field, spec, waterLevel, depthGrid);
        if (altProf.ok || altProf.violations.length < best.violations.length) {
          bestRoute = altRoute;
          best = altProf;
        }
      }
    }
    route = bestRoute;
    const prof = best;
    const end = route[route.length - 1] ?? spec.entrance;
    const endDistance = Math.hypot(end.x - r.center.x, end.z - r.center.z);
    const reached = prof.ok && route.length > 1 && endDistance <= Math.max(r.radius * 0.7, 2.5);
    walks.push({ ...trace('walk-' + r.id, r.name, route, prof, spec, endDistance), regionId: r.id, reached });
    regionRoutes.set(r.id, route);
  }

  let corridorWalk: WalkTrace | null = null;
  const corridorRoute: Vec2[] = [];
  if (corridor && corridor.samples.length > 1) {
    const route = corridor.samples.map((s) => ({ x: s.x, z: s.z }));
    if (Math.hypot(route[0].x - spec.entrance.x, route[0].z - spec.entrance.z) > 25) {
      const link = findPath(nav, spec.entrance, route[0], { bias: route, allowPartial: false });
      if (link.points.length > 1) route.unshift(...link.points.slice(0, -1));
    }
    const prof = profilePath(route, field, spec, waterLevel, depthGrid);
    corridorWalk = trace('corridor', '作者通路', route, prof, spec, 0);
    corridorRoute.push(...route);
  }

  return { walks, corridorWalk, corridorRoute, regionRoutes };
}

function emptyProfile(): ProfileCheck {
  return { ok: false, violations: ['无可通行路径'], points: [], length: 0, maxGrade: 0, minClearance: 0, minWidth: 0 };
}

function nearestPointIndex(points: Vec2[], at: Vec2): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].x - at.x) ** 2 + (points[i].z - at.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function trace(id: string, label: string, route: Vec2[], prof: ProfileCheck, spec: LevelSpec, endDistance: number): WalkTrace {
  const points: WalkPoint[] = [];
  let t = 0;
  for (let i = 0; i < prof.points.length; i++) {
    const p = prof.points[i];
    if (i > 0) {
      const prev = prof.points[i - 1];
      t += Math.hypot(p.x - prev.x, p.z - prev.z) / spec.character.speed;
    }
    points.push({ x: p.x, z: p.z, y: p.y, t, grade: p.grade, clearance: p.clearance });
  }
  const ok = prof.ok && route.length > 1;
  return {
    id,
    label,
    points,
    success: ok,
    violations: prof.violations,
    duration: t,
    length: prof.length,
    maxGrade: prof.maxGrade,
    minClearance: prof.minClearance,
    endDistance,
  };
}

export function slopesOf(field: HeightField): { median: number; p95: number; max: number; histogram: number[] } {
  const values: number[] = [];
  const n = field.vertexCount;
  const step = field.size / field.res;
  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const hx = (field.get(ix + 1, iz) - field.get(ix - 1, iz)) / (2 * step);
      const hz = (field.get(ix, iz + 1) - field.get(ix, iz - 1)) / (2 * step);
      values.push((Math.atan(Math.hypot(hx, hz)) * 180) / Math.PI);
    }
  }
  values.sort((a, b) => a - b);
  const hist = new Array(10).fill(0);
  for (const v of values) hist[Math.min(9, Math.floor(v / 5))]++;
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values[values.length - 1] ?? 0,
    histogram: hist.map((c) => (values.length > 0 ? c / values.length : 0)),
  };
}

export function distanceToPolyline(x: number, z: number, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2));
    const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
    if (d < best) best = d;
  }
  return best;
}

export function meanDistanceToRoute(route: Vec2[], reference: Vec2[]): number {
  if (route.length === 0 || reference.length === 0) return 0;
  let sum = 0;
  for (const p of route) sum += distanceToPolyline(p.x, p.z, reference);
  return sum / route.length;
}

export function routeLength(route: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
  return total;
}
