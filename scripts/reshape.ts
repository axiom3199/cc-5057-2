/**
 * Auxiliary CLI for the multi-scale local reshape.
 *
 * The authoring path is the graphical level editor (`npm run dev`); this script exists so the same
 * reshape can be exercised headlessly and diffed in CI. It generates a clean map, applies one
 * authored edit (ridge lateral move, corridor narrowing, or route shift), replays only the
 * affected window, and prints the seam/LOD/route report next to a full-generation control.
 *
 *   npx vite-node scripts/reshape.ts -- --ridge-offset 18 --full
 *   npx vite-node scripts/reshape.ts -- --corridor-width 3 --full
 *   npx vite-node scripts/reshape.ts -- --route-offset 12 --edit-scale 1.4 --full
 */
import { generateLevel, toSnapshot } from '../src/core/generator';
import { applyReshapeEdits, fullControl, reshapeLevel } from '../src/core/reshape';
import { BASE_SPEC, SCENARIOS, cloneSpec } from '../src/core/scenarios';
import type { LevelSpec } from '../src/core/types';

interface Args {
  scenario: string;
  seed: number | null;
  resolution: number;
  ridgeOffset: number;
  corridorWidth: number | null;
  routeOffset: number;
  editScale: number;
  full: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: 'clean',
    seed: null,
    resolution: 180,
    ridgeOffset: 0,
    corridorWidth: null,
    routeOffset: 0,
    editScale: 1,
    full: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i];
    switch (a) {
      case '--scenario':
        args.scenario = next();
        break;
      case '--seed':
        args.seed = Number(next());
        break;
      case '--resolution':
        args.resolution = Number(next());
        break;
      case '--ridge-offset':
        args.ridgeOffset = Number(next());
        break;
      case '--corridor-width':
        args.corridorWidth = Number(next());
        break;
      case '--route-offset':
        args.routeOffset = Number(next());
        break;
      case '--edit-scale':
        args.editScale = Number(next());
        break;
      case '--full':
        args.full = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function cleanSpec(args: Args): LevelSpec {
  if (args.scenario === 'clean') {
    const spec = cloneSpec(BASE_SPEC);
    spec.seed = 2411;
    spec.locks = { riverbed: false, pass: false };
    spec.erosion = 0;
    spec.resolution = args.resolution;
    if (args.seed !== null) spec.seed = args.seed;
    return spec;
  }
  const sc = SCENARIOS.find((s) => s.id === args.scenario);
  if (!sc) throw new Error(`Unknown scenario: ${args.scenario} (try: clean, ${SCENARIOS.map((s) => s.id).join(', ')})`);
  const spec = sc.prerequisite ? sc.prerequisite() : sc.build();
  spec.resolution = args.resolution;
  if (args.seed !== null) spec.seed = args.seed;
  return spec;
}

function editedSpec(base: LevelSpec, args: Args): LevelSpec {
  return applyReshapeEdits(base, {
    ridgeOffset: args.ridgeOffset,
    corridorWidth: args.corridorWidth ?? undefined,
    routeOffset: args.routeOffset,
  });
}

function deg(grade: number): string {
  return `${((Math.atan(grade) * 180) / Math.PI).toFixed(1)}°`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const clean = cleanSpec(args);
  const t0 = performance.now();
  const cleanResult = generateLevel(clean);
  const previous = toSnapshot(cleanResult, 'clean');
  if (!previous) {
    console.error(`Clean map was not accepted (${cleanResult.status}); cannot reshape. Messages:`);
    for (const m of cleanResult.messages) console.error(`  - ${m}`);
    process.exit(1);
  }

  const spec = editedSpec(clean, args);
  const control = args.full ? fullControl(spec) : null;
  const result = reshapeLevel({
    previous,
    spec,
    label: 'cli-reshape',
    editScale: args.editScale,
    runFullControl: args.full,
    fullControl: control,
  });
  const report = result.reshape;
  if (!report) {
    console.error('No reshape report was produced.');
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify({ report, status: result.status, messages: result.messages }, null, 2));
    return;
  }

  const sign = (v: number): string => (v > 0 ? `+${v}` : String(v));
  console.log(`RIDGELINE local reshape — scenario=${args.scenario} seed=${spec.seed} res=${spec.resolution}`);
  console.log(
    `edit: ridge-offset=${sign(args.ridgeOffset)} m, corridor-width=${args.corridorWidth ?? 'authored'} m, route-offset=${sign(args.routeOffset)} m, edit-scale=${args.editScale}×`,
  );
  console.log(`clean generation: ${cleanResult.status} in ${(performance.now() - t0).toFixed(0)} ms`);
  console.log('');
  console.log(`result: ${result.status} (${report.mode}) in ${report.elapsedMs.toFixed(0)} ms (${report.patchMs.toFixed(0)} ms patch)`);
  console.log(
    `window: ${report.bounds ? `${report.bounds.minX.toFixed(0)}…${report.bounds.maxX.toFixed(0)} × ${report.bounds.minZ.toFixed(0)}…${report.bounds.maxZ.toFixed(0)} m` : '—'}`,
  );
  console.log(`blocks: ${report.blocks.length} (patched ${report.blocks.filter((b) => b.mode === 'patched').length})`);
  console.log(`vertices: ${report.patchedCells} changed / ${report.frozenCells} frozen of ${report.totalCells}`);
  console.log(`seam: max ${report.seam.maxStep.toFixed(2)} m at ${report.seam.maxSlopeDeg.toFixed(1)}° (${report.seam.ok ? 'ok' : 'FAIL'})`);
  console.log(
    `LOD: coarse ${report.lod.coarseRes}² vs fine ${report.lod.fineRes}², agreement ${(report.lod.finalAgreement * 100).toFixed(0)}% (${(report.lod.deltaAgreement * 100).toFixed(0)}% edit-delta)`,
  );
  console.log(`navigation: corridor ${report.navigation.corridorWalkSuccess ? 'walkable' : 'blocked'}, regions ${report.navigation.regionsReached}/${report.routes.length}`);
  console.log('');
  console.log('routes:');
  console.log(`  corridor: ${deg(report.corridorRoute.maxGradeBefore)} -> ${deg(report.corridorRoute.maxGradeAfter)}, net width ${report.corridorRoute.minWidthBefore.toFixed(2)} -> ${report.corridorRoute.minWidthAfter.toFixed(2)} m${report.corridorRoute.changed ? ' (changed)' : ''}`);
  for (const r of report.routes) {
    console.log(`  ${r.name}: ${r.reachedBefore ? 'reached' : 'unreached'} -> ${r.reachedAfter ? 'reached' : 'unreached'}, grade ${deg(r.maxGradeBefore)} -> ${deg(r.maxGradeAfter)}, length ${r.lengthBefore.toFixed(0)} -> ${r.lengthAfter.toFixed(0)} m${r.changed ? ' (changed)' : ''}`);
  }
  if (report.conflicts.length > 0) {
    console.log('');
    console.log('conflicts:');
    for (const c of report.conflicts) {
      console.log(`  [${c.kind}] ${c.label}: ${c.detail}`);
      for (const a of c.adjustable) {
        console.log(`    - ${a.label}: ${a.min.toFixed(1)}…${a.max.toFixed(1)}${a.unit} (current ${a.current.toFixed(1)}, suggested ${a.suggested.toFixed(1)}) — ${a.note}`);
      }
    }
  }
  if (control && report.fullControl) {
    console.log('');
    console.log('full-generation control:');
    console.log(`  status ${report.fullControl.status}, grade ${deg(report.fullControl.maxGrade)}, net width ${report.fullControl.minNetWidth.toFixed(2)} m`);
    console.log(`  field agreement: max ${report.fullControl.maxFieldDelta.toFixed(2)} m, mean ${report.fullControl.meanFieldDelta.toFixed(2)} m`);
  }
  console.log('');
  console.log('messages:');
  for (const m of result.messages) console.log(`  - ${m}`);
}

main();
