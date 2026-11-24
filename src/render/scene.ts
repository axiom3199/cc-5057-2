import * as THREE from 'three';
import { PolylineIndex } from '../core/math';
import type { GenerationResult, ReshapeReport, Vec2 } from '../core/types';

export interface SelectionPoint {
  x: number;
  z: number;
}

export interface SceneHandle {
  dispose(): void;
  setResult(result: GenerationResult): void;
  /** Draw the patched/frozen block grid and work window of the latest local reshape. */
  setReshapeOverlay(report: ReshapeReport | null): void;
  setWalkProgress(t: number): void;
  focusOn(point: Vec2): void;
  setCameraPreset(preset: 'overview' | 'trail' | 'regions'): void;
  screenshot(): string;
  onPick(cb: (p: SelectionPoint) => void): void;
  debug: {
    shadows(on: boolean): void;
    materials(name: string): string[];
    toggle(name: string, on: boolean): void;
  };
}

interface Palette {
  low: number;
  mid: number;
  high: number;
  rock: number;
  snow: number;
  water: number;
}

const PALETTES: Record<string, Palette> = {
  alpine: { low: 0x3f6b47, mid: 0x6f7d55, high: 0x9aa0a0, rock: 0x7b7268, snow: 0xf2f6f8, water: 0x3f7fb6 },
  arid: { low: 0xa8926a, mid: 0xbfa878, high: 0xcbb98c, rock: 0xa07f5e, snow: 0xe9e0cc, water: 0x4a90a8 },
  karst: { low: 0x4f7a5a, mid: 0x7d8a63, high: 0x9d9a86, rock: 0x8a7f6c, snow: 0xdfe6e2, water: 0x3f8fa0 },
};

export function createScene(container: HTMLElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f141b);
  scene.fog = new THREE.Fog(0x0f141b, 520, 1100);

  const camera = new THREE.PerspectiveCamera(52, container.clientWidth / container.clientHeight, 0.5, 3000);
  camera.position.set(240, 250, 300);

  const controls = new OrbitControlsLite(renderer.domElement, camera);
  controls.target.set(0, 30, 0);
  controls.update();

  const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x2a2418, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
  sun.position.set(320, 460, 180);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -320;
  sun.shadow.camera.right = 320;
  sun.shadow.camera.top = 320;
  sun.shadow.camera.bottom = -320;
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 1400;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 1.4;
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x404a5a, 0.5));

  const root = new THREE.Group();
  scene.add(root);

  const markerGroup = new THREE.Group();
  root.add(markerGroup);

  let result: GenerationResult | null = null;
  let walkCurves: THREE.CatmullRomCurve3[] = [];
  let character: THREE.Group | null = null;
  let overwriteGroup: THREE.Group | null = null;
  let regionGroup: THREE.Group | null = null;
  let reshapeGroup: THREE.Group | null = null;
  let raf = 0;
  let progress = 0;
  let clockT = 0;

  const pickCb: { fn: ((p: SelectionPoint) => void) | null } = { fn: null };

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pickMesh: THREE.Mesh | null = null;

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!result || !pickMesh) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(pickMesh, false)[0];
    if (hit && pickCb.fn) {
      pickCb.fn({ x: hit.point.x, z: hit.point.z });
    }
  });

  function resize(): void {
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  function disposeRoot(): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    root.clear();
    walkCurves = [];
    pickMesh = null;
    character = null;
    overwriteGroup = null;
    regionGroup = null;
    reshapeGroup = null;
  }

  function buildTerrain(result: GenerationResult): THREE.Mesh {
    const { field, spec } = result;
    const res = field.res;
    const n = res + 1;
    const geometry = new THREE.PlaneGeometry(field.size, field.size, res, res);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const palette = PALETTES[spec.landform.palette] ?? PALETTES.alpine;
    const low = new THREE.Color(palette.low);
    const mid = new THREE.Color(palette.mid);
    const high = new THREE.Color(palette.high);
    const rock = new THREE.Color(palette.rock);
    const snow = new THREE.Color(palette.snow);
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let i = 0; i < field.heights.length; i++) {
      hMin = Math.min(hMin, field.heights[i]);
      hMax = Math.max(hMax, field.heights[i]);
    }
    const span = Math.max(1, hMax - hMin);
    const waterLevel = result.riverWaterLevel;
    for (let i = 0; i < pos.count; i++) {
      const ix = i % n;
      const iz = Math.floor(i / n);
      // PlaneGeometry rows go from -z to +z; grid index iz maps directly.
      const h = field.heights[iz * n + ix];
      pos.setY(i, h);
      const t = (h - hMin) / span;
      const c = new THREE.Color();
      if (t < 0.42) c.copy(low).lerp(mid, t / 0.42);
      else if (t < 0.72) c.copy(mid).lerp(high, (t - 0.42) / 0.3);
      else c.copy(high).lerp(snow, Math.min(1, (t - 0.72) / 0.28));
      // Rock on steep faces.
      if (ix > 0 && ix < res && iz > 0 && iz < res) {
        const hx = (field.heights[iz * n + ix + 1] - field.heights[iz * n + ix - 1]) / (2 * (field.size / res));
        const hz = (field.heights[(iz + 1) * n + ix] - field.heights[(iz - 1) * n + ix]) / (2 * (field.size / res));
        const slope = Math.atan(Math.hypot(hx, hz));
        if (slope > (spec.character.maxSlopeDeg * Math.PI) / 180) {
          c.lerp(rock, Math.min(0.8, (slope - (spec.character.maxSlopeDeg * Math.PI) / 180) * 1.6));
        }
      }
      // Riverbed tint.
      if (result.water[iz * n + ix] === 1) c.lerp(new THREE.Color(palette.water), 0.55);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.02,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    void waterLevel;
    return mesh;
  }

  function buildWater(result: GenerationResult): THREE.Group {
    const group = new THREE.Group();
    const { field, water } = result;
    const res = field.res;
    const n = res + 1;
    const palette = PALETTES[result.spec.landform.palette] ?? PALETTES.alpine;
    const base = new THREE.Color(palette.water);
    const cell = field.size / res;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        // Emit one quad per wet cell so deep "dry" vertices never stretch a triangle over land.
        let sum = 0;
        let wet = 0;
        for (let dz = 0; dz <= 1; dz++) {
          for (let dx = 0; dx <= 1; dx++) {
            const idx = (iz + dz) * n + (ix + dx);
            if (water[idx]) {
              sum += field.heights[idx];
              wet++;
            }
          }
        }
        if (wet < 2) continue;
        const surf = sum / wet + 0.55;
        const x0 = -field.size / 2 + ix * cell;
        const z0 = -field.size / 2 + iz * cell;
        const b = positions.length / 3;
        positions.push(x0, surf, z0, x0 + cell, surf, z0, x0 + cell, surf, z0 + cell, x0, surf, z0 + cell);
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    }
    if (positions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      const colors = new Float32Array((positions.length / 3) * 3);
      for (let i = 0; i < positions.length / 3; i++) {
        colors[i * 3] = base.r;
        colors[i * 3 + 1] = base.g;
        colors[i * 3 + 2] = base.b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        roughness: 0.18,
        metalness: 0.1,
        emissive: 0x0a1a26,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 1;
      group.add(mesh);
    }
    return group;
  }

  function buildCorridor(result: GenerationResult): THREE.Group {
    const group = new THREE.Group();
    if (!result.corridor) return group;
    const samples = result.corridor.samples;
    const width = result.corridor.width;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const good = new THREE.Color(0x62e3a4);
    const bad = new THREE.Color(0xff5a5a);
    const need = result.spec.character.radius * 2 + 0.6;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const half = width / 2;
      positions.push(s.x + s.nx * half, s.h + 0.14, s.z + s.nz * half);
      positions.push(s.x - s.nx * half, s.h + 0.14, s.z - s.nz * half);
      const c = s.netWidth + 1e-3 < need ? bad : good;
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (i > 0) {
        const a = (i - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    group.add(mesh);

    // Centre line: the graded bench.
    const linePts = samples.map((s) => new THREE.Vector3(s.x, s.h + 0.2, s.z));
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x8ef0bd, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(lineGeo, lineMat);
    line.renderOrder = 3;
    group.add(line);
    return group;
  }

  function buildWalkTraces(result: GenerationResult): { group: THREE.Group; curves: THREE.CatmullRomCurve3[] } {
    const group = new THREE.Group();
    const curves: THREE.CatmullRomCurve3[] = [];
    const traces: { points: Vec2[]; y: number[]; color: number }[] = [];
    const walkColors = [0x63c7ff, 0xffd166, 0xff8fab, 0x9b8cff];
    result.walk.forEach((w, i) => {
      traces.push({
        points: w.points.map((p) => ({ x: p.x, z: p.z })),
        y: w.points.map((p) => p.y),
        color: walkColors[i % walkColors.length],
      });
    });
    if (result.corridorWalk) {
      traces.push({
        points: result.corridorWalk.points.map((p) => ({ x: p.x, z: p.z })),
        y: result.corridorWalk.points.map((p) => p.y),
        color: 0x46ffb0,
      });
    }
    for (const tr of traces) {
      if (tr.points.length < 2) continue;
      const vecs = tr.points.map((p, i) => new THREE.Vector3(p.x, tr.y[i] + 0.5, p.z));
      const curve = new THREE.CatmullRomCurve3(vecs, false, 'catmullrom', 0.4);
      curves.push(curve);
      const sampled = curve.getPoints(Math.max(2, Math.min(1400, vecs.length)));
      const geo = new THREE.BufferGeometry().setFromPoints(sampled.map((v) => new THREE.Vector3(v.x, v.y + 0.35, v.z)));
      const mat = new THREE.LineBasicMaterial({ color: tr.color, transparent: true, opacity: 0.92 });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 4;
      group.add(line);
    }
    return { group, curves };
  }

  function buildRegions(result: GenerationResult): THREE.Group {
    const group = new THREE.Group();
    for (const r of result.spec.regions) {
      const walk = result.walk.find((w) => w.regionId === r.id);
      const reached = walk?.reached ?? false;
      const y = result.field.heights[
        Math.round(((r.center.z + result.field.size / 2) / result.field.size) * result.field.res) * (result.field.res + 1) +
          Math.round(((r.center.x + result.field.size / 2) / result.field.size) * result.field.res)
      ] ?? 0;
      const ringGeo = new THREE.RingGeometry(r.radius * 0.92, r.radius, 40);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: reached ? 0x66e0ff : 0xff5a5a,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(r.center.x, y + 1.2, r.center.z);
      ring.renderOrder = 5;
      group.add(ring);
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 0.8, Math.max(8, y - result.field.size * 0.02), 8),
        new THREE.MeshBasicMaterial({ color: reached ? 0x66e0ff : 0xff5a5a, transparent: true, opacity: 0.35 }),
      );
      pillar.position.set(r.center.x, y + 14, r.center.z);
      group.add(pillar);
      const label = makeLabelSprite(`${r.order}. ${r.name}${reached ? '' : '（未达）'}`, reached ? '#a9ecff' : '#ffb0b0');
      label.position.set(r.center.x, y + 34, r.center.z);
      label.scale.set(34, 8.5, 1);
      group.add(label);
    }
    return group;
  }

  function buildOverwrites(result: GenerationResult): THREE.Group {
    const group = new THREE.Group();
    // Show where *designed* grading changed the ground: amber = cut, cyan = fill, with the river on
    // top. The broader pit-drain pass also changes the field (it raises incidental hollows so runoff
    // can leave), but that is hydrology maintenance, not authored landform: painting it would tint
    // whole lowlands as if they had been bulldozed. Restrict the overlay to the trail bench and the
    // pass it is repaired through.
    const { field, baseField, riverPath } = result;
    const res = field.res;
    const n = res + 1;
    const cell = field.size / res;
    const bench = result.corridor
      ? new PolylineIndex(result.corridor.samples.map((s) => ({ x: s.x, z: s.z })), field.size, 10)
      : null;
    const benchReach = result.corridor ? result.corridor.width / 2 + result.spec.corridor.shoulder + 4 : 0;
    const pass = result.passCenter;
    const passReach = result.spec.pass.radius * 1.5;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const cut = new THREE.Color(0xe0a54a);
    const fill = new THREE.Color(0x48b8c8);
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const idx = iz * n + ix;
        const diff = field.heights[idx] - (baseField[idx] ?? field.heights[idx]);
        if (Math.abs(diff) < 1.0) continue;
        const x = -field.size / 2 + (ix + 0.5) * cell;
        const z = -field.size / 2 + (iz + 0.5) * cell;
        const onBench = bench !== null && (bench.closest(x, z)?.distance ?? Infinity) < benchReach;
        const onPass = Math.hypot(x - pass.x, z - pass.z) < passReach;
        if (!onBench && !onPass) continue;
        // Drape the quad over the four grid corners. A flat quad at one cell's height would intersect
        // an inclined slope and break into dashes; anchored to the corners it follows the surface.
        const corners = [idx, idx + 1, idx + n + 1, idx + n];
        const c = diff >= 0 ? fill : cut;
        const weight = Math.min(1, 0.3 + Math.abs(diff) * 0.1);
        const cc = c.clone().multiplyScalar(weight);
        const base = positions.length / 3;
        for (const ci of corners) {
          const cx = -field.size / 2 + (ci % n) * cell;
          const cz = -field.size / 2 + Math.floor(ci / n) * cell;
          positions.push(cx, field.heights[ci] + 0.16, cz);
          colors.push(cc.r, cc.g, cc.b);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 1;
      group.add(mesh);
    }

    // River path ribbon.
    if (riverPath.length > 1) {
      const pts = riverPath.map((p) => new THREE.Vector3(p.x, result.field.heights[rowOf(result, p)] + 1.0, p.z));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: 0x5ec8ff, linewidth: 2 });
      group.add(new THREE.Line(geo, mat));
    }
    return group;
  }

  function rowOf(result: GenerationResult, p: Vec2): number {
    const res = result.field.res;
    const ix = Math.round(((p.x + result.field.size / 2) / result.field.size) * res);
    const iz = Math.round(((p.z + result.field.size / 2) / result.field.size) * res);
    return iz * (res + 1) + ix;
  }

  /**
   * Review overlay for a local reshape: one translucent quad per block inside the work window,
   * amber where the window was patched and slate where it was left frozen, plus a bright frame
   * around the window. This is what lets an author see *which* terrain layers moved.
   */
  function buildReshapeOverlay(report: ReshapeReport): THREE.Group {
    const group = new THREE.Group();
    if (!report.bounds || report.blocks.length === 0 || !result) return group;
    const { field } = result;
    const res = field.res;
    const n = res + 1;
    const cell = field.size / res;
    const blockCell = Math.max(1, Math.round(res / Math.max(4, report.blockCount)));
    const heightAt = (x: number, z: number): number => {
      const ix = Math.max(0, Math.min(res, Math.round(((x + field.size / 2) / field.size) * res)));
      const iz = Math.max(0, Math.min(res, Math.round(((z + field.size / 2) / field.size) * res)));
      return field.heights[iz * n + ix] ?? 0;
    };
    const patched = new THREE.Color(0xffb347);
    const frozen = new THREE.Color(0x3d6a8f);
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (const b of report.blocks) {
      const ix0 = b.bx * blockCell;
      const iz0 = b.bz * blockCell;
      const ix1 = Math.min(res, ix0 + blockCell);
      const iz1 = Math.min(res, iz0 + blockCell);
      if (ix1 <= ix0 || iz1 <= iz0) continue;
      const x0 = -field.size / 2 + ix0 * cell;
      const x1 = -field.size / 2 + ix1 * cell;
      const z0 = -field.size / 2 + iz0 * cell;
      const z1 = -field.size / 2 + iz1 * cell;
      const c = b.mode === 'patched' ? patched : frozen;
      const strength = b.mode === 'patched' ? Math.min(1, 0.28 + b.maxDelta * 0.05) : 0.14;
      const base = positions.length / 3;
      for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as [number, number][]) {
        positions.push(x, heightAt(x, z) + 0.35, z);
        colors.push(c.r * strength, c.g * strength, c.b * strength);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    if (positions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'reshape-blocks';
      mesh.renderOrder = 2;
      group.add(mesh);
    }

    // Window frame. Lift it above the highest ground in the window so it stays visible.
    const { minX, maxX, minZ, maxZ } = report.bounds;
    let top = -Infinity;
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      top = Math.max(
        top,
        heightAt(minX + (maxX - minX) * t, minZ),
        heightAt(minX + (maxX - minX) * t, maxZ),
        heightAt(minX, minZ + (maxZ - minZ) * t),
        heightAt(maxX, minZ + (maxZ - minZ) * t),
      );
    }
    const y = top + 3.5;
    const pts = [
      new THREE.Vector3(minX, y, minZ),
      new THREE.Vector3(maxX, y, minZ),
      new THREE.Vector3(maxX, y, maxZ),
      new THREE.Vector3(minX, y, maxZ),
      new THREE.Vector3(minX, y, minZ),
      new THREE.Vector3(maxX, y, minZ),
    ];
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: report.rolledBack ? 0xff6b6b : 0x8ef0bd, transparent: true, opacity: 0.9 }),
    );
    line.renderOrder = 6;
    group.add(line);
    group.name = 'reshape';
    return group;
  }

  function setReshapeOverlay(report: ReshapeReport | null): void {
    if (reshapeGroup) {
      root.remove(reshapeGroup);
      reshapeGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      reshapeGroup = null;
    }
    if (report && report.blocks.length > 0) {
      reshapeGroup = buildReshapeOverlay(report);
      root.add(reshapeGroup);
    }
  }

  function makeLabelSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(8, 14, 22, 0.72)';
    roundRect(ctx, 6, 26, 500, 76, 16);
    ctx.fill();
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    return sprite;
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function buildCharacter(): THREE.Group {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x553f10, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 1.1, 6, 10), bodyMat);
    body.position.y = 1.15;
    body.castShadow = true;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0x332a10 }));
    head.position.y = 2.15;
    head.castShadow = true;
    g.add(head);
    return g;
  }

  function setResult(next: GenerationResult): void {
    result = next;
    disposeRoot();
    root.add(buildTerrain(next));
    const water = buildWater(next);
    water.name = 'water';
    root.add(water);
    overwriteGroup = buildOverwrites(next);
    overwriteGroup.name = 'overlay';
    root.add(overwriteGroup);
    const corridorGroup = buildCorridor(next);
    corridorGroup.name = 'corridor';
    root.add(corridorGroup);
    regionGroup = buildRegions(next);
    regionGroup.name = 'regions';
    root.add(regionGroup);
    const walk = buildWalkTraces(next);
    walk.group.name = 'walks';
    walkCurves = walk.curves;
    root.add(walk.group);
    const terrain = root.getObjectByName('terrain') as THREE.Mesh | undefined;
    if (terrain) pickMesh = terrain;
    character = buildCharacter();
    root.add(character);
    // Local-reshape review overlay rides with the terrain it describes.
    reshapeGroup = null;
    setReshapeOverlay(next.reshape ?? null);
    setWalkProgress(0);
    // Frame the map.
    frameAll();
  }

  function setWalkProgress(t: number): void {
    progress = Math.max(0, Math.min(1, t));
    if (!character || walkCurves.length === 0) return;
    const lengths = walkCurves.map((c) => c.getLength());
    const total = lengths.reduce((a, b) => a + b, 0) || 1;
    let remaining = progress * total;
    let chosen = walkCurves[0];
    let local = 0;
    for (let i = 0; i < walkCurves.length; i++) {
      if (remaining <= lengths[i] || i === walkCurves.length - 1) {
        chosen = walkCurves[i];
        local = lengths[i] > 0 ? Math.min(1, remaining / lengths[i]) : 1;
        break;
      }
      remaining -= lengths[i];
    }
    const p = chosen.getPointAt(local);
    character.position.set(p.x, p.y + 0.2, p.z);
    const tangent = chosen.getTangentAt(local);
    character.rotation.y = Math.atan2(tangent.x, tangent.z);
  }

  function frameAll(): void {
    controls.target.set(0, 24, 0);
    camera.position.set(250, 260, 300);
    controls.update();
  }

  function focusOn(point: Vec2): void {
    const y = result ? result.field.heights[rowOf(result, point)] : 30;
    controls.target.set(point.x, y, point.z);
    camera.position.set(point.x + 70, y + 80, point.z + 90);
    controls.update();
  }

  function setCameraPreset(preset: 'overview' | 'trail' | 'regions'): void {
    if (!result) return;
    if (preset === 'overview') {
      frameAll();
    } else if (preset === 'trail' && result.corridor) {
      const s = result.corridor.samples;
      const mid = s[Math.floor(s.length / 2)];
      focusOn(mid);
    } else if (preset === 'regions') {
      const r = result.spec.regions[0];
      if (r) focusOn(r.center);
    }
  }

  function loop(): void {
    raf = requestAnimationFrame(loop);
    clockT += 0.016;
    if (result && character) {
      // Gentle bobbing so the marker reads as a walking character.
      character.position.y += Math.sin(clockT * 6) * 0.004;
      if (progress > 0 && progress < 1) {
        setWalkProgress(progress + 0.0016);
      }
    }
    controls.update();
    renderer.render(scene, camera);
  }
  loop();

  function screenshot(): string {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  }

  function dispose(): void {
    cancelAnimationFrame(raf);
    ro.disconnect();
    disposeRoot();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    dispose,
    setResult,
    setReshapeOverlay,
    setWalkProgress,
    focusOn,
    setCameraPreset,
    screenshot,
    onPick(cb) {
      pickCb.fn = cb;
    },
    debug: {
      shadows(on: boolean): void {
        renderer.shadowMap.enabled = on;
        sun.castShadow = on;
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.material) (m.material as THREE.Material).needsUpdate = true;
        });
      },
      materials(name: string): string[] {
        const out: string[] = [];
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && (!name || o.name === name)) {
            const mat = m.material;
            out.push(`${o.name || '(unnamed)'}:${Array.isArray(mat) ? 'multi' : mat?.type}`);
          }
        });
        return out;
      },
      toggle(name: string, on: boolean): void {
        const g = root.getObjectByName(name);
        if (g) g.visible = on;
      },
    },
  };
}

/** Minimal orbit controls so the viewport works without the addon's module interop. */
class OrbitControlsLite {
  readonly target = new THREE.Vector3();
  private dragging = false;
  private button = 0;
  private lastX = 0;
  private lastY = 0;
  private camera: THREE.PerspectiveCamera;

  constructor(el: HTMLElement, camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private spherical(): THREE.Spherical {
    return new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(this.camera.position, this.target));
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.button = e.button;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const sph = this.spherical();
    if (this.button === 2 || e.shiftKey) {
      const panScale = sph.radius * 0.0014;
      const right = new THREE.Vector3().crossVectors(this.camera.up, this.camera.getWorldDirection(new THREE.Vector3())).normalize();
      this.target.addScaledVector(right, dx * panScale);
      const fwd = this.camera.getWorldDirection(new THREE.Vector3());
      fwd.y = 0;
      fwd.normalize();
      this.target.addScaledVector(fwd, dy * panScale);
    } else {
      sph.theta -= dx * 0.005;
      sph.phi = Math.max(0.08, Math.min(Math.PI / 2 - 0.02, sph.phi - dy * 0.005));
    }
    const offset = new THREE.Vector3().setFromSpherical(sph);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  };

  private onUp = (): void => {
    this.dragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const sph = this.spherical();
    sph.radius = Math.max(20, Math.min(1400, sph.radius * (1 + Math.sign(e.deltaY) * 0.12)));
    const offset = new THREE.Vector3().setFromSpherical(sph);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  };

  update(): void {
    this.camera.lookAt(this.target);
  }
}
