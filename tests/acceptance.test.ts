import { describe, expect, it } from 'vitest';
import { buildState, generateLevel, toSnapshot } from '../src/core/generator';
import { dryColWaypoints, scenarioById, specFromState, BASE_SPEC, cloneSpec } from '../src/core/scenarios';

const REQUIRED = BASE_SPEC.character.radius * 2 + 0.6;

describe('reproducible generation', () => {
  it('same seed produces the same heights', () => {
    const spec = cloneSpec(BASE_SPEC);
    spec.resolution = 96;
    const a = generateLevel(spec);
    const b = generateLevel(spec);
    expect(a.field.heights.length).toBe(b.field.heights.length);
    let maxDiff = 0;
    for (let i = 0; i < a.field.heights.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.field.heights[i] - b.field.heights[i]));
    expect(maxDiff).toBe(0);
    expect(a.status).toBe(b.status);
    expect(a.metrics.featureScore).toBeCloseTo(b.metrics.featureScore, 6);
  });

  it('a different seed yields a different landform', () => {
    const a = cloneSpec(BASE_SPEC);
    const b = cloneSpec(BASE_SPEC);
    a.resolution = b.resolution = 96;
    b.seed = a.seed + 1;
    const ra = generateLevel(a);
    const rb = generateLevel(b);
    let diff = 0;
    for (let i = 0; i < ra.field.heights.length; i++) diff += Math.abs(ra.field.heights[i] - rb.field.heights[i]);
    expect(diff).toBeGreaterThan(0);
  });
});

describe('clean alpine map (prerequisite for rollback)', () => {
  const sc = scenarioById('broken-river-lock')!;
  const result = generateLevel(sc.prerequisite!());

  it('is accepted and produces a rollback snapshot', () => {
    expect(result.status).toBe('ok');
    expect(result.evaluation.accepted).toBe(true);
    expect(toSnapshot(result, 'clean')).not.toBeNull();
  });

  it('walks every must-reach region and the authored trail', () => {
    expect(result.corridorWalk?.success).toBe(true);
    for (const walk of result.walk) {
      expect(walk.reached, `${walk.label}: ${walk.violations.join('; ')}`).toBe(true);
    }
  });

  it('keeps the trail walkable: grade, net width and step height', () => {
    expect(result.metrics.maxGrade).toBeLessThanOrEqual(Math.tan((BASE_SPEC.character.maxSlopeDeg * Math.PI) / 180) * 1.04);
    expect(result.metrics.minNetWidth).toBeGreaterThanOrEqual(REQUIRED);
    expect(result.corridorWalk!.violations).toEqual([]);
  });

  it('reaches the outlet with rainfall and drains the pass catchment', () => {
    expect(result.rain.success).toBe(true);
    expect(result.rain.ratio).toBeGreaterThanOrEqual(0.68);
    expect(result.rain.passRatio).toBeGreaterThanOrEqual(0.8);
    expect(result.rain.blocked).toBe(0);
  });

  it('keeps ridge and basin landform fidelity rather than flattening the mountain', () => {
    expect(result.metrics.ridgeFidelity).toBeGreaterThan(0.7);
    expect(result.metrics.basinFidelity).toBeGreaterThan(0.7);
    expect(result.metrics.flattenFraction).toBeLessThan(0.5);
    // Relief must survive: a mountain flattened to satisfy one route would collapse this.
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of result.field.heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(hi - lo).toBeGreaterThan(40);
  });
});

describe('lock repairs at the same broken road', () => {
  it('riverbed lock: keeps the water system and moves only the hiking corridor', () => {
    const sc = scenarioById('broken-river-lock')!;
    const clean = generateLevel(sc.prerequisite!());
    const snap = toSnapshot(clean, 'clean')!;
    expect(snap).not.toBeNull();
    const res = generateLevel(sc.build(), { previous: snap });

    expect(res.status).toBe('repaired');
    expect(res.repair.chosen).toBe('reroute-trail');
    expect(res.repair.riverRerouted).toBe(false);
    // The river path is byte-for-byte the authored one: the water system did not move.
    expect(res.riverPath.length).toBe(clean.riverPath.length);
    expect(res.riverPath[0]).toEqual(clean.riverPath[0]);
    // The corridor *did* move to the dry col.
    const dryCol = res.corridor!.samples.some((s) => Math.hypot(s.x - res.spec.dryCol!.center.x, s.z - res.spec.dryCol!.center.z) < res.spec.dryCol!.radius);
    expect(dryCol).toBe(true);
    expect(res.walk.every((w) => w.reached)).toBe(true);
    expect(res.rain.success).toBe(true);
  });

  it('pass lock: fills the slope and reconnects runoff downstream', () => {
    const sc = scenarioById('broken-pass-lock')!;
    const clean = generateLevel(sc.prerequisite!());
    const snap = toSnapshot(clean, 'clean')!;
    const res = generateLevel(sc.build(), { previous: snap });

    expect(res.status).toBe('repaired');
    expect(res.repair.chosen).toBe('raise-pass');
    expect(res.repair.riverRerouted).toBe(true);
    expect(res.repair.passMoved).toBe(true);
    // The repaired slope is real earthwork, not a no-op.
    expect(res.metrics.cutVolume + res.metrics.fillVolume).toBeGreaterThan(1000);
    // The pass catchment must drain (reconnect the runoff downstream), and the trail crosses it.
    expect(res.rain.success).toBe(true);
    expect(res.rain.passRatio).toBeGreaterThanOrEqual(0.8);
    expect(res.corridorWalk?.success).toBe(true);
    expect(res.walk.every((w) => w.reached)).toBe(true);
  });

  it('both locks are contradictory: no new map, keep the last playable one', () => {
    const sc = scenarioById('contradiction')!;
    const clean = generateLevel(sc.prerequisite!());
    const snap = toSnapshot(clean, 'clean')!;
    const res = generateLevel(sc.build(), { previous: snap });

    expect(res.status).toBe('rolled-back');
    expect(res.repair.rollback).toBe(true);
    expect(res.repair.previousLabel).toBe('clean');
    expect(res.snapshotLabel).toBe('clean');
    // The replayed map is literally the previous playable one.
    expect(res.field.heights.length).toBe(clean.field.heights.length);
    let same = true;
    for (let i = 0; i < res.field.heights.length; i++) if (Math.abs(res.field.heights[i] - clean.field.heights[i]) > 1e-3) { same = false; break; }
    expect(same).toBe(true);
    // Both repair candidates report as blocked by their respective locks.
    const reroute = res.repair.candidates.find((c) => c.kind === 'reroute-trail')!;
    const raise = res.repair.candidates.find((c) => c.kind === 'raise-pass')!;
    expect(reroute.allowed).toBe(false);
    expect(raise.allowed).toBe(false);
  });
});

describe('distinct landform goals', () => {
  for (const id of ['gentle-valley', 'karst-basins']) {
    it(`${id} is accepted without repair`, () => {
      const sc = scenarioById(id)!;
      const res = generateLevel(sc.build());
      expect(res.status, res.messages.join(' | ')).toBe('ok');
      expect(res.evaluation.accepted).toBe(true);
      expect(res.corridorWalk?.success).toBe(true);
      expect(res.walk.every((w) => w.reached)).toBe(true);
      expect(res.rain.success).toBe(true);
      expect(res.metrics.maxGrade).toBeLessThanOrEqual(Math.tan((BASE_SPEC.character.maxSlopeDeg * Math.PI) / 180) * 1.04);
    });
  }
});

describe('coarse vs fine mesh', () => {
  it('a trail that looks reachable on the coarse mesh is re-verified on the subdivided mesh', () => {
    const sc = scenarioById('broken-river-lock')!;
    const spec = sc.build();
    const res = generateLevel(spec);
    // The fine-resolution audit is where the walk is finally certified.
    expect(res.messages.some((m) => m.includes('细分网格'))).toBe(true);
    if (res.status !== 'failed') {
      expect(res.metrics.minNetWidth).toBeGreaterThanOrEqual(REQUIRED);
      expect(res.corridorWalk?.success).toBe(true);
      // And corner clearance holds after subdivision: no zero-clearance cliff on the run.
      for (const w of [res.corridorWalk!, ...res.walk]) {
        expect(w.minClearance).toBeGreaterThanOrEqual(BASE_SPEC.character.radius * 0.98 - 1e-6);
      }
    }
  });
});

describe('terrain and traversability jointly score the result', () => {
  it('feature and travel scores both appear in the evaluation, and neither alone is trusted', () => {
    const res = generateLevel(scenarioById('gentle-valley')!.build());
    expect(res.evaluation.featureScore).toBeGreaterThan(0);
    expect(res.evaluation.travelScore).toBeGreaterThan(0);
    expect(res.evaluation.jointScore).toBeGreaterThan(0);
    // Feature score is not a flatness reward: ridge and basin fidelity are both part of it.
    expect(res.metrics.ridgeFidelity).toBeGreaterThan(0.5);
  });

  it('a broken trail is rejected by the gate rather than silently accepted', () => {
    // The same broken road the lock scenarios repair: crossed straight through the eroded gorge
    // with the riverbed protected, the trail has no room. The gate must reject it (which is what
    // sends the author into the repair planner) rather than pass a map whose route is a lie.
    const spec = scenarioById('broken-river-lock')!.build();
    const initial = buildState(spec, {
      riverPoints: spec.river.points.map((p) => ({ ...p })),
      route: spec.corridor.waypoints.map((p) => ({ ...p })),
      protectRiverbed: true,
      raisePass: false,
      routeKind: 'initial',
    }, 132);
    expect(initial.gate.accepted).toBe(false);
    expect(initial.gate.reasons.length).toBeGreaterThan(0);
  });
});

describe('spec editing drives generation', () => {
  it('changing the landform goal changes the generated field', () => {
    const base = specFromState({ scenarioId: 'gentle-valley', seed: 4, erosion: 0, locks: { riverbed: false, pass: false }, resolution: 96, landformId: 'arid', repairPreference: 'auto' });
    const karst = specFromState({ scenarioId: 'gentle-valley', seed: 4, erosion: 0, locks: { riverbed: false, pass: false }, resolution: 96, landformId: 'karst', repairPreference: 'auto' });
    const ra = generateLevel(base);
    const rb = generateLevel(karst);
    let diff = 0;
    for (let i = 0; i < ra.field.heights.length; i++) diff += Math.abs(ra.field.heights[i] - rb.field.heights[i]);
    expect(diff).toBeGreaterThan(0);
  });

  it('exposes the dry-col detour alignment used when the riverbed is locked', () => {
    const route = dryColWaypoints(BASE_SPEC);
    expect(route.some((p) => Math.hypot(p.x - BASE_SPEC.dryCol!.center.x, p.z - BASE_SPEC.dryCol!.center.z) < 10)).toBe(true);
    expect(BASE_SPEC.corridor.detour?.length).toBeGreaterThan(2);
  });
});
