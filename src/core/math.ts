export interface Vec2 {
  x: number;
  z: number;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Tolerance for testing whether a grid vertex lies inside a reshape window. A vertex computed at
 * the window plane can land a few ulps either side depending on how its coordinate is derived, so
 * a single authoritative helper (with this epsilon) keeps the pipeline, the exterior merge and the
 * seam audit in agreement about which vertices are "inside".
 */
export const BOUNDS_EPS = 1e-6;

export const withinBounds = (
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  x: number,
  z: number,
): boolean => x >= minX - BOUNDS_EPS && x <= maxX + BOUNDS_EPS && z >= minZ - BOUNDS_EPS && z <= maxZ + BOUNDS_EPS;

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export const callSmoothMax = (a: number, b: number, k: number): number => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return lerp(a, b, h) + k * h * (1 - h);
};

export const dist2 = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz);

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export interface Noise2D {
  value(x: number, z: number): number;
  fbm(x: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
  ridged(x: number, z: number, octaves?: number): number;
}

export function makeNoise2D(seed: number): Noise2D {
  const value = (x: number, z: number): number => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fz = z - z0;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const a = hash2(x0, z0, seed);
    const b = hash2(x0 + 1, z0, seed);
    const c = hash2(x0, z0 + 1, seed);
    const d = hash2(x0 + 1, z0 + 1, seed);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  };
  const fbm = (x: number, z: number, octaves = 5, lacunarity = 2.03, gain = 0.5): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += value(x * freq, z * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };
  const ridged = (x: number, z: number, octaves = 4): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(value(x * freq, z * freq) * 2 - 1);
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.07;
    }
    return sum / norm;
  };
  return { value, fbm, ridged };
}

export interface PolylineHit {
  distance: number;
  closest: Vec2;
  segment: number;
  t: number;
}

export function closestOnPolyline(px: number, pz: number, pts: Vec2[]): PolylineHit {
  let best: PolylineHit = {
    distance: Infinity,
    closest: { x: pts[0]?.x ?? px, z: pts[0]?.z ?? pz },
    segment: 0,
    t: 0,
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 === 0 ? 0 : clamp(((px - a.x) * abx + (pz - a.z) * abz) / len2, 0, 1);
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < best.distance) best = { distance: d, closest: { x: cx, z: cz }, segment: i, t };
  }
  return best;
}

export function polylineLength(pts: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return total;
}

export function pointInPolygon(px: number, pz: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const zi = poly[i].z;
    const xj = poly[j].x;
    const zj = poly[j].z;
    const intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function chaikin(pts: Vec2[], iterations = 2): Vec2[] {
  let out = pts;
  for (let it = 0; it < iterations; it++) {
    if (out.length < 3) return out;
    const next: Vec2[] = [{ ...out[0] }];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push({ ...out[out.length - 1] });
    out = next;
  }
  return out;
}

export function resamplePolyline(pts: Vec2[], spacing: number): Vec2[] {
  if (pts.length === 0) return [];
  const out: Vec2[] = [{ ...pts[0] }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen === 0) continue;
    let d = spacing - carry;
    while (d <= segLen) {
      const t = d / segLen;
      out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
      d += spacing;
    }
    carry = segLen - (d - spacing);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > 1e-4) out.push({ ...last });
  return out;
}

export function normalAt(pts: Vec2[], i: number): Vec2 {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  const tx = b.x - a.x;
  const tz = b.z - a.z;
  const len = Math.hypot(tx, tz) || 1;
  return { x: -tz / len, z: tx / len };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : lerp(sorted[lo], sorted[hi], idx - lo);
}

export interface ClosestSample {
  distance: number;
  index: number;
  t: number;
  x: number;
  z: number;
}

/** Uniform bucket grid for nearest-point queries against a polyline sample set. */
export class PolylineIndex {
  readonly points: Vec2[];
  private readonly cell: number;
  private readonly buckets = new Map<number, number[]>();
  private readonly origin: number;

  constructor(points: Vec2[], size: number, cell = 8) {
    this.points = points;
    this.cell = cell;
    this.origin = -size / 2;
    for (let i = 0; i < points.length; i++) {
      const key = this.key(points[i].x, points[i].z);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i);
      else this.buckets.set(key, [i]);
    }
  }

  private key(x: number, z: number): number {
    const cx = Math.floor((x - this.origin) / this.cell);
    const cz = Math.floor((z - this.origin) / this.cell);
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  closest(x: number, z: number, maxRing = 4): ClosestSample | null {
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      const cx = Math.floor((x - this.origin) / this.cell);
      const cz = Math.floor((z - this.origin) / this.cell);
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const bucket = this.buckets.get((cx + dx + 4096) * 8192 + (cz + dz + 4096));
          if (!bucket) continue;
          for (const i of bucket) {
            const p = this.points[i];
            const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      if (best >= 0 && Math.sqrt(bestD) < ring * this.cell - this.cell) break;
    }
    if (best < 0) return null;
    // Project onto the adjacent segments for a continuous along-path parameter.
    const i = best;
    let bt = 0;
    let bx = this.points[i].x;
    let bz = this.points[i].z;
    let bd = bestD;
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= this.points.length) continue;
      const a = this.points[j];
      const b = this.points[j + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 === 0 ? 0 : clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
      const qx = a.x + abx * t;
      const qz = a.z + abz * t;
      const d = (qx - x) * (qx - x) + (qz - z) * (qz - z);
      if (d <= bd) {
        bd = d;
        bx = qx;
        bz = qz;
        bt = j + t;
      }
    }
    return { distance: Math.sqrt(bd), index: i, t: bt, x: bx, z: bz };
  }
}

