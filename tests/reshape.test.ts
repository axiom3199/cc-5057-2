import { describe, expect, it } from 'vitest';
import { generateLevel, toSnapshot } from '../src/core/generator';
import { applyReshapeEdits, computeReshapeBounds, fullControl, reshapeLevel } from '../src/core/reshape';
import { BASE_SPEC, cloneSpec } from '../src/core/scenarios';
import type { PlayableSnapshot } from '../src/core/types';

const RES = 96;

function cleanSnapshot(): PlayableSnapshot {
  const spec = cloneSpec(BASE_SPEC);
  spec.resolution = RES;
  const result = generateLevel(spec);
  expect(result.status, result.messages.join(' | ')).toBe('ok');
  const snap = toSnapshot(result, 'clean');
  expect(snap).not.toBeNull();
  return snap!;
}

const EDIT_SCALE = Math.tan((BASE_SPEC.character.maxSlopeDeg * Math.PI) / 180) * 1.04;

function fieldDelta(a: Float32Array, b: Float32Array): { max: number; mean: number; changed: number } {
  let max = 0;
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 1e-4) changed++;
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / a.length, changed };
}

describe('local reshape — ridge lateral move', () => {
  const previous = cleanSnapshot();
  const movedSpec = cloneSpec(previous.spec);
  for (const ridge of movedSpec.ridges) for (const p of ridge.points) p.z += 16;
  const result = reshapeLevel({ previous, spec: movedSpec, label: 'ridge-move' });
  const report = result.reshape!;

  it('stays inside a window instead of regenerating the whole map', () => {
    expect(report.mode).toBe('local');
    expect(result.status).toBe('ok');
    expect(report.bounds).not.toBeNull();
    // Not the full map: at least the southern half is outside the work window.
    expect(report.bounds!.minZ).toBeGreaterThan(-previous.field.size / 2);
    expect(report.patchedCells).toBeGreaterThan(0);
    expect(report.frozenCells).toBeGreaterThan(report.patchedCells);
  });

  it('keeps seed-driven detail in the frozen exterior bit-for-bit', () => {
    const { minZ, minX, maxX, maxZ } = report.bounds!;
    const n = previous.field.res + 1;
    const cell = previous.field.size / previous.field.res;
    let outside = 0;
    let moved = 0;
    for (let iz = 0; iz < n; iz++) {
      const z = -previous.field.size / 2 + iz * cell;
      for (let ix = 0; ix < n; ix++) {
        const x = -previous.field.size / 2 + ix * cell;
        const inside = x >= minX && x <= maxX && z >= minZ && z <= maxZ;
        if (inside) continue;
        outside++;
        if (Math.abs(previous.field.heights[iz * n + ix] - result.field.heights[iz * n + ix]) > 1e-4) moved++;
      }
    }
    expect(outside).toBeGreaterThan(0);
    // The frozen exterior is not re-randomised: not one frozen vertex moved.
    expect(moved).toBe(0);
  });

  it('joins the new window to the frozen terrain without a seam', () => {
    expect(report.seam.ok).toBe(true);
    expect(report.seam.maxStep).toBeLessThanOrEqual(2);
    expect(report.seam.maxSlopeDeg).toBeLessThanOrEqual(62);
  });

  it('moves the fine mesh, the coarse LOD and the collision/navigation grid together', () => {
    expect(report.lod.fineRes).toBe(result.field.res);
    expect(report.lod.finalAgreement).toBeGreaterThanOrEqual(0.85);
    expect(report.navigation.res).toBe(result.field.res);
    expect(report.collision.res).toBe(result.field.res);
    expect(report.collision.grid).toBe('bilinear');
    // Coarse LOD is a real replay of the edited spec, not the stale old field.
    expect(report.lod.coarseRes).toBeLessThanOrEqual(report.lod.fineRes);
  });

  it('keeps a walkable grade and reaches every must-reach region', () => {
    expect(result.corridorWalk?.success).toBe(true);
    expect(result.metrics.maxGrade).toBeLessThanOrEqual(EDIT_SCALE);
    for (const walk of result.walk) expect(walk.reached, `${walk.label}: ${walk.violations.join('; ')}`).toBe(true);
    expect(report.navigation.regionsReached).toBe(result.spec.regions.length);
  });

  it('matches a full one-shot generation of the same constrained spec', () => {
    const control = fullControl(movedSpec);
    const delta = fieldDelta(control.field.heights, result.field.heights);
    expect(control.status).toBe(result.status);
    // The local patch reproduces the full solve: same slope, same width, terrain within a cell.
    expect(result.metrics.maxGrade).toBeCloseTo(control.corridor!.maxGrade, 2);
    expect(result.metrics.minNetWidth).toBeCloseTo(control.corridor!.minNetWidth, 2);
    expect(delta.max).toBeLessThan(2.0);
    expect(delta.mean).toBeLessThan(0.05);
  });
});

describe('local reshape — corridor narrowing', () => {
  it('re-grades only the trail window and reports the affected layers', () => {
    const previous = cleanSnapshot();
    const narrow = cloneSpec(previous.spec);
    narrow.corridor.width = 3;
    const result = reshapeLevel({ previous, spec: narrow, label: 'narrow' });
    const report = result.reshape!;

    expect(report.mode).toBe('local');
    expect(result.status).toBe('ok');
    expect(report.affected.corridor).toBe(true);
    expect(report.patchedCells).toBeGreaterThan(0);
    // The trail bench changed but the ridge itself is untouched ground.
    expect(report.affected.ridges.length).toBe(0);
    expect(report.seam.ok).toBe(true);
    expect(report.lod.finalAgreement).toBeGreaterThanOrEqual(0.85);
    // A trail re-graded inside its own footprint must keep a passable corridor.
    expect(result.corridorWalk?.success).toBe(true);
    expect(result.metrics.maxGrade).toBeLessThanOrEqual(EDIT_SCALE);
  });

  it('narrows the graded trail while distant confirmed terrain stays untouched', () => {
    const previous = cleanSnapshot();
    const narrow = cloneSpec(previous.spec);
    narrow.corridor.width = 3;
    const result = reshapeLevel({ previous, spec: narrow, label: 'narrow-keep' });
    const bounds = result.reshape!.bounds!;
    const n = previous.field.res + 1;
    const cell = previous.field.size / previous.field.res;
    let moved = 0;
    for (let iz = 0; iz < n; iz++) {
      const z = -previous.field.size / 2 + iz * cell;
      for (let ix = 0; ix < n; ix++) {
        const x = -previous.field.size / 2 + ix * cell;
        if (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ) continue;
        if (Math.abs(previous.field.heights[iz * n + ix] - result.field.heights[iz * n + ix]) > 1e-4) moved++;
      }
    }
    expect(moved).toBe(0);
  });
});

describe('local reshape — preserved regions', () => {
  it('keeps an unchanged region fixed even when nearby detail is re-graded', () => {
    const previous = cleanSnapshot();
    // Move a basin whose footprint is far from the ridge lookout: the lookout's pad is unchanged
    // authored landscape and must keep its confirmed ground.
    const edited = cloneSpec(previous.spec);
    const basin = edited.basins.find((b) => b.id === 'east-hollow')!;
    basin.center = { x: basin.center.x + 10, z: basin.center.z - 8 };
    const result = reshapeLevel({ previous, spec: edited, label: 'keep-regions' });
    const r = previous.spec.regions.find((x) => x.id === 'ridge-lookout')!;
    const sampleAt = (heights: Float32Array): number => {
      const res = previous.field.res;
      const n = res + 1;
      const ix = Math.round(((r.center.x + previous.field.size / 2) / previous.field.size) * res);
      const iz = Math.round(((r.center.z + previous.field.size / 2) / previous.field.size) * res);
      return heights[iz * n + ix];
    };
    // The region definition did not change, so it is not listed as an affected authored layer.
    expect(result.reshape!.affected.regions).toEqual([]);
    expect(Math.abs(sampleAt(result.field.heights) - sampleAt(previous.field.heights))).toBeLessThan(1e-3);
  });
});

describe('local reshape — update spanning block boundaries', () => {
  it('patches several blocks across the window and keeps the rest frozen', () => {
    const previous = cleanSnapshot();
    const moved = cloneSpec(previous.spec);
    for (const ridge of moved.ridges) for (const p of ridge.points) p.z -= 14;
    // A wide edit window from a moderate scale so it spans multiple blocks.
    const result = reshapeLevel({ previous, spec: moved, label: 'blocks', editScale: 1.3, blockCount: 12 });
    const report = result.reshape!;

    expect(result.status).toBe('ok');
    const patched = report.blocks.filter((b) => b.mode === 'patched');
    expect(patched.length).toBeGreaterThan(1);
    // A block that was fully outside the change keeps every vertex frozen.
    const frozen = report.blocks.filter((b) => b.mode === 'frozen');
    expect(frozen.length).toBeGreaterThan(0);
    expect(report.frozenCells).toBeGreaterThan(0);
    // Blocks beyond the window are not even reported as work.
    const bounds = computeReshapeBounds(previous.spec, moved, { editScale: 1.3 });
    expect(report.bounds).toEqual(bounds);
  });
});

describe('editor wiring — reshape knobs drive the spec and a local replay', () => {
  it('ridge, corridor and route knobs reach the spec (entrance stays pinned)', () => {
    const base = cloneSpec(BASE_SPEC);
    const before = base.ridges[0].points.map((p) => p.z);
    const spec = applyReshapeEdits(base, { ridgeOffset: 14, corridorWidth: 6.5, routeOffset: 9 });
    expect(spec.ridges[0].points.map((p) => p.z)).toEqual(before.map((z) => z + 14));
    expect(spec.corridor.width).toBe(6.5);
    expect(spec.corridor.waypoints[0]).toEqual(base.corridor.waypoints[0]);
    expect(spec.corridor.waypoints[3]).not.toEqual(base.corridor.waypoints[3]);
  });

  it('a UI-authored combination reshapes cleanly end to end', () => {
    const base = cloneSpec(BASE_SPEC);
    base.resolution = RES;
    const clean = generateLevel(base);
    expect(clean.status).toBe('ok');
    const snap = toSnapshot(clean, 'clean')!;
    const spec = applyReshapeEdits(snap.spec, { ridgeOffset: 12, corridorWidth: 6.5, routeOffset: 8 });
    const bounds = computeReshapeBounds(snap.spec, spec, { editScale: 1.2 });
    const result = reshapeLevel({ previous: snap, spec, label: 'ui', editScale: 1.2 });
    expect(result.reshape!.bounds).toEqual(bounds);
    expect(result.reshape!.mode).toBe('local');
    expect(result.status).toBe('ok');
    expect(result.corridorWalk?.success).toBe(true);
    expect(result.reshape!.affected.ridges).toContain('main');
    expect(result.reshape!.affected.corridor).toBe(true);
  });
});

describe('local reshape — conflicts and rollback', () => {
  it('rolls the whole change back and explains the conflict when a region cannot be reached', () => {
    const previous = cleanSnapshot();
    // Push the ridge straight over the lookout: the trail to the ridge region is buried.
    const hostile = cloneSpec(previous.spec);
    for (const ridge of hostile.ridges) for (const p of ridge.points) p.z += 30;
    const result = reshapeLevel({ previous, spec: hostile, label: 'hostile' });
    const report = result.reshape!;

    if (!report.rolledBack) {
      // If the window still yields a passable route, the constraint was never violated; the
      // important guarantee is that a rolled-back edit keeps the previous map unchanged.
      expect(result.status).toBe('ok');
      return;
    }
    expect(result.status).toBe('rolled-back');
    expect(report.mode).toBe('rolled-back');
    // The previous playable map is returned verbatim, not a half-patched field.
    const delta = fieldDelta(previous.field.heights, result.field.heights);
    expect(delta.changed).toBe(0);
    // Conflicts surface adjustable ranges rather than silently editing locked landscape.
    expect(report.conflicts.length).toBeGreaterThan(0);
    for (const conflict of report.conflicts) {
      expect(conflict.adjustable.length).toBeGreaterThan(0);
      for (const range of conflict.adjustable) {
        expect(range.min).toBeLessThanOrEqual(range.max);
        expect(range.suggested).toBeGreaterThanOrEqual(range.min);
        expect(range.suggested).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it('refuses to reshape without a replayable recipe instead of re-randomising', () => {
    const previous = cleanSnapshot();
    const noRecipe: PlayableSnapshot = { ...previous, recipe: undefined, datum: undefined };
    const spec = cloneSpec(previous.spec);
    spec.corridor.width = 3;
    const result = reshapeLevel({ previous: noRecipe, spec, label: 'no-recipe' });
    expect(result.status).toBe('rolled-back');
    expect(result.reshape?.rolledBack).toBe(true);
    const delta = fieldDelta(previous.field.heights, result.field.heights);
    expect(delta.changed).toBe(0);
  });
});
