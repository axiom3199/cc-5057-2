import './ui/styles.css';
import { createScene } from './render/scene';
import { generateLevel, exportPackage, toSnapshot } from './core/generator';
import { LANDFORMS, SCENARIOS, scenarioById, specFromState, type DemoState } from './core/scenarios';
import type { GenerationResult, LevelSpec, PlayableSnapshot, Vec2 } from './core/types';

const app = document.getElementById('app') as HTMLDivElement;

app.innerHTML = `
  <div class="layout">
    <aside class="panel controls">
      <header class="brand">
        <div class="brand-mark">◆</div>
        <div>
          <h1>RIDGELINE</h1>
          <p>山地探索 · 关卡生成台</p>
        </div>
      </header>
      <section class="group">
        <h2>关卡场景</h2>
        <div id="scenario-list" class="scenario-list"></div>
        <p id="scenario-blurb" class="hint"></p>
      </section>
      <section class="group">
        <h2>生成内核</h2>
        <label class="field">
          <span>种子</span>
          <input id="seed" type="number" min="1" step="1" />
        </label>
        <label class="field">
          <span>地貌目标</span>
          <select id="landform"></select>
        </label>
        <label class="field">
          <span>网格分辨率 <b id="res-value"></b></span>
          <input id="resolution" type="range" min="96" max="256" step="16" />
        </label>
        <label class="field">
          <span>侵蚀强度 <b id="erosion-value"></b></span>
          <input id="erosion" type="range" min="0" max="0.6" step="0.02" />
        </label>
        <div class="field">
          <span>锁定</span>
          <div class="chips">
            <button id="lock-river" class="chip" type="button">锁定河床</button>
            <button id="lock-pass" class="chip" type="button">锁定唯一山口</button>
          </div>
        </div>
        <label class="field">
          <span>修补偏好</span>
          <select id="preference">
            <option value="auto">自动（比较通行成本与地貌扰动）</option>
            <option value="reroute-trail">保留水系 · 移走走廊</option>
            <option value="raise-pass">保留旧山口 · 填坡改道</option>
          </select>
        </label>
        <div class="actions">
          <button id="generate" class="primary" type="button">生成关卡</button>
          <button id="snapshot" type="button">保存为可通关地图</button>
        </div>
        <div class="actions">
          <button id="load-base" type="button">载入无断口底图</button>
        </div>
        <p id="snapshot-note" class="hint">先载入无断口底图并保存为「上一张可通关地图」，再点选断口场景即可测试修补与回退。</p>
      </section>
      <section class="group">
        <h2>视图</h2>
        <div class="actions wrap">
          <button id="cam-overview" type="button">俯瞰</button>
          <button id="cam-trail" type="button">沿步道</button>
          <button id="cam-regions" type="button">必达区</button>
          <button id="replay" type="button">重播通行</button>
        </div>
        <label class="field">
          <span>角色通行进度 <b id="progress-value">0%</b></span>
          <input id="progress" type="range" min="0" max="1000" step="1" value="0" />
        </label>
        <div class="actions wrap">
          <button id="export" type="button">导出关卡 JSON</button>
          <button id="screenshot" type="button">保存截图</button>
        </div>
      </section>
    </aside>

    <main class="viewport">
      <div id="scene" class="scene"></div>
      <div class="status-bar">
        <span id="status-pill" class="pill">等待生成</span>
        <span id="status-detail"></span>
      </div>
      <div class="legend">
        <span><i class="sw sw-trail"></i>作者通路</span>
        <span><i class="sw sw-walk"></i>必达区路线</span>
        <span><i class="sw sw-cut"></i>挖方</span>
        <span><i class="sw sw-fill"></i>填方</span>
        <span><i class="sw sw-water"></i>水系</span>
        <span><i class="sw sw-pin"></i>必达区</span>
      </div>
    </main>

    <aside class="panel results">
      <section class="group">
        <h2>验收结果</h2>
        <div id="verdict" class="verdict"></div>
        <div id="metrics" class="metrics"></div>
      </section>
      <section class="group">
        <h2>约束区域与生成误差</h2>
        <div id="constraints" class="constraints"></div>
        <div class="error-scale">
          <span>误差低</span><i></i><span>高</span>
        </div>
      </section>
      <section class="group">
        <h2>坡度分布</h2>
        <div id="histogram" class="histogram"></div>
      </section>
      <section class="group">
        <h2>通行与降雨验收</h2>
        <div id="acceptance" class="acceptance"></div>
      </section>
      <section class="group">
        <h2>修补候选</h2>
        <div id="repairs" class="repairs"></div>
      </section>
      <section class="group">
        <h2>日志</h2>
        <div id="log" class="log"></div>
      </section>
    </aside>
  </div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const sceneHost = $<HTMLDivElement>('scene');
const scene = createScene(sceneHost);

const state: DemoState & { scenarioId: string } = {
  scenarioId: SCENARIOS[0].id,
  seed: 2411,
  erosion: 0,
  locks: { riverbed: false, pass: false },
  resolution: 180,
  landformId: 'alpine',
  repairPreference: 'auto',
};

let current: GenerationResult | null = null;
let savedSnapshot: PlayableSnapshot | null = null;
let baseSpec: LevelSpec = scenarioById(state.scenarioId)!.build();
let lastSpec: LevelSpec = baseSpec;
let busy = false;

function scenarioList(): void {
  const host = $<HTMLDivElement>('scenario-list');
  host.innerHTML = '';
  for (const sc of SCENARIOS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scenario' + (sc.id === state.scenarioId ? ' active' : '');
    btn.innerHTML = `<b>${sc.name}</b><small>期望：${statusLabel(sc.expectedStatus)}</small>`;
    btn.addEventListener('click', () => {
      state.scenarioId = sc.id;
      const spec = sc.build();
      state.seed = spec.seed;
      state.erosion = spec.erosion;
      state.locks = { ...spec.locks };
      state.resolution = spec.resolution;
      state.landformId = spec.landform.id as DemoState['landformId'];
      state.repairPreference = spec.repairPreference;
      syncInputs(spec);
      scenarioList();
      $<HTMLParagraphElement>('scenario-blurb').textContent = `${sc.blurb}`;
    });
    host.appendChild(btn);
  }
  $<HTMLParagraphElement>('scenario-blurb').textContent = SCENARIOS.find((s) => s.id === state.scenarioId)!.blurb;
}

function syncInputs(spec: LevelSpec): void {
  $<HTMLInputElement>('seed').value = String(state.seed);
  $<HTMLSelectElement>('landform').value = state.landformId;
  $<HTMLInputElement>('resolution').value = String(state.resolution);
  $<HTMLInputElement>('erosion').value = String(state.erosion);
  $<HTMLSelectElement>('preference').value = state.repairPreference;
  $<HTMLSpanElement>('res-value').textContent = `${state.resolution}²`;
  $<HTMLSpanElement>('erosion-value').textContent = `${(state.erosion * 100).toFixed(0)}%`;
  updateLockChips();
  void spec;
}

function updateLockChips(): void {
  $<HTMLButtonElement>('lock-river').classList.toggle('on', state.locks.riverbed);
  $<HTMLButtonElement>('lock-pass').classList.toggle('on', state.locks.pass);
}

function statusLabel(s: string): string {
  return ({ ok: '可行', repaired: '已修补', 'rolled-back': '已回退', failed: '未通过' } as Record<string, string>)[s] ?? s;
}

function buildSpec(): LevelSpec {
  const sc = scenarioById(state.scenarioId);
  baseSpec = sc ? sc.build() : lastSpec;
  if (sc && !state.locks.riverbed && !state.locks.pass && state.erosion === 0) {
    // Keep scenario landform nuance (basin radii etc.) but apply current knobs.
  }
  const spec = specFromState(state);
  lastSpec = spec;
  return spec;
}

async function generate(): Promise<void> {
  if (busy) return;
  busy = true;
  setBusy(true);
  try {
    await frame();
    const spec = buildSpec();
    const result = generateLevel(spec, { previous: savedSnapshot });
    current = result;
    lastSpec = spec;
    scene.setResult(result);
    renderResults(result);
    setStatus(result);
    $<HTMLSpanElement>('progress-value').textContent = '0%';
    $<HTMLInputElement>('progress').value = '0';
  } catch (err) {
    console.error(err);
    $<HTMLDivElement>('log').innerHTML = `<p class="err">生成失败：${String(err)}</p>`;
  } finally {
    busy = false;
    setBusy(false);
  }
}

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

// Generate the intact map behind the broken scenarios so it can be saved as the rollback target.
// Without this the author could only ever meet a repaired map, and the "keep the last playable
// map" branch would have nothing clean to fall back to.
async function loadBaseMap(): Promise<void> {
  const sc = scenarioById(state.scenarioId);
  const base = sc?.prerequisite ? sc.prerequisite() : null;
  if (!base) return;
  state.seed = base.seed;
  state.erosion = base.erosion;
  state.locks = { ...base.locks };
  state.resolution = base.resolution;
  state.landformId = base.landform.id as DemoState['landformId'];
  state.repairPreference = base.repairPreference;
  syncInputs(base);
  await generate();
}

function setBusy(on: boolean): void {
  $<HTMLButtonElement>('generate').disabled = on;
  $<HTMLButtonElement>('generate').textContent = on ? '生成中…' : '生成关卡';
  sceneHost.classList.toggle('busy', on);
}

function setStatus(result: GenerationResult): void {
  const pill = $<HTMLSpanElement>('status-pill');
  pill.textContent = statusLabel(result.status);
  pill.className = `pill status-${result.status}`;
  $<HTMLSpanElement>('status-detail').textContent = `种子 ${result.spec.seed} · ${result.spec.landform.name} · ${result.field.res}² 网格 · 用时 ${result.elapsedMs.toFixed(0)} ms`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function renderResults(result: GenerationResult): void {
  const verdict = $<HTMLDivElement>('verdict');
  const ev = result.evaluation;
  verdict.className = `verdict ${ev.accepted ? 'pass' : 'fail'}`;
  const why = ev.reasons.length ? ev.reasons : result.status === 'rolled-back' ? ['本次改动与锁定冲突，已保留上一张可通关地图。'] : ['地形特征与可通行条件同时达标。'];
  verdict.innerHTML = `
    <div class="badge">${statusLabel(result.status)}</div>
    <ul>${why.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
  `;

  const m = result.metrics;
  $<HTMLDivElement>('metrics').innerHTML = row([
    ['综合评分', m.featureScore.toFixed(2), m.travelScore.toFixed(2), ev.jointScore.toFixed(2)],
    ['山口净宽', `${result.passWidth.width.toFixed(1)} m`, '需要', `${m.requiredWidth.toFixed(2)} m`],
    ['最大坡度', `${(Math.atan(m.maxGrade) * 180 / Math.PI).toFixed(1)}°`, '角色上限', `${result.spec.character.maxSlopeDeg}°`],
    ['走廊净宽', `${m.minNetWidth.toFixed(2)} m`, '坡中位', `${m.medianSlopeDeg.toFixed(1)}°`],
    ['地貌扰动', pct(m.disturbance), '挖/填', `${m.cutVolume.toFixed(0)} / ${m.fillVolume.toFixed(0)} m³`],
    ['生成误差', m.generationError.toFixed(3), '压平比例', pct(m.flattenFraction)],
  ]);

  // Constraint regions and error.
  const constraintHost = $<HTMLDivElement>('constraints');
  const regionRows = result.spec.regions
    .map((r) => {
      const walk = result.walk.find((w) => w.regionId === r.id);
      const ok = walk?.reached;
      return `<div class="constraint ${ok ? 'ok' : 'bad'}">
        <b>${escapeHtml(r.name)}</b>
        <span>${ok ? '已抵达' : '未抵达'}</span>
        <small>${walk ? `${walk.length.toFixed(0)} m · 末点距 ${walk.endDistance.toFixed(1)} m` : '无路线'}</small>
      </div>`;
    })
    .join('');
  const basinRows = result.spec.basins
    .map((b) => `<div class="constraint"><b>${escapeHtml(b.name)}</b><span>盆地</span><small>半径 ${b.radius} m · 底 ${b.floor} m</small></div>`)
    .join('');
  constraintHost.innerHTML = regionRows + basinRows;

  // Slope histogram.
  const hist = $<HTMLDivElement>('histogram');
  hist.innerHTML = '';
  const bins = m.slopeHistogram;
  const maxFrac = Math.max(0.0001, ...bins.map((b) => b.fraction));
  bins.forEach((b) => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.title = `${b.from}–${b.to}°：${pct(b.fraction)}`;
    bar.innerHTML = `<i style="height:${(b.fraction / maxFrac) * 100}%"></i><span>${b.from}</span>`;
    hist.appendChild(bar);
  });

  // Acceptance.
  const rain = result.rain;
  const walkOk = result.walk.every((w) => w.reached);
  const corridorOk = result.corridorWalk?.success ?? false;
  $<HTMLDivElement>('acceptance').innerHTML = `
    <div class="check ${walkOk ? 'ok' : 'bad'}">人物过关：${walkOk ? '三处必达区全部抵达' : '存在未抵达的必达区'}</div>
    <div class="check ${corridorOk ? 'ok' : 'bad'}">作者通路：${corridorOk ? '角色可全程通行' : '无法全程通行'}</div>
    <div class="check ${rain.success ? 'ok' : 'bad'}">降雨模拟：${escapeHtml(rain.summary)}</div>
    <div class="check ${rain.passRatio >= 0.8 ? 'ok' : 'bad'}">山口汇水：${pct(rain.passRatio)} 排除或蓄于盆地</div>
    ${result.corridorWalk?.violations.length ? `<div class="check bad">通行告警：${result.corridorWalk.violations.slice(0, 3).map(escapeHtml).join('；')}</div>` : ''}
  `;

  // Repairs.
  const repairs = $<HTMLDivElement>('repairs');
  repairs.innerHTML = `
    <div class="repair-note">${escapeHtml(result.repair.reason)}</div>
    ${result.repair.candidates
      .map(
        (c) => `<div class="candidate ${c.feasible ? 'ok' : c.allowed ? 'warn' : 'bad'}">
          <b>${repairLabel(c.kind)}</b>
          <span>${c.allowed ? (c.feasible ? '可行' : '不可行') : '被锁定排除'}</span>
          <small>${escapeHtml(c.note)}</small>
          <small>通行成本 ${Number.isFinite(c.traversalCost) ? c.traversalCost.toFixed(0) : '—'} · 扰动 ${Number.isFinite(c.disturbance) ? pct(c.disturbance) : '—'}</small>
        </div>`,
      )
      .join('')}
  `;

  $<HTMLDivElement>('log').innerHTML = result.messages.map((m2) => `<p>${escapeHtml(m2)}</p>`).join('');
}

function repairLabel(k: string): string {
  return ({ 'reroute-trail': '移走走廊（保水系）', 'raise-pass': '填坡改道（保旧山口）', rollback: '回退到上一张地图', none: '无需修补', failed: '未修补' } as Record<string, string>)[k] ?? k;
}

function row(items: [string, string, string, string][]): string {
  return items
    .map(
      ([k, v, k2, v2]) => `<div class="metric"><span class="k">${k}</span><span class="v">${v}</span><span class="k">${k2}</span><span class="v2">${v2}</span></div>`,
    )
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function saveSnapshot(): void {
  if (!current) return;
  const snap = toSnapshot(current, `${current.spec.seed}`);
  const note = $<HTMLParagraphElement>('snapshot-note');
  if (snap) {
    savedSnapshot = snap;
    note.textContent = `已保存「${snap.label}」为上一张可通关地图。制造断口或双锁后可测试回退。`;
    note.classList.add('ok');
  } else {
    note.textContent = '当前地图未通过验收，不能保存为可通关地图。请先修正生成参数。';
    note.classList.remove('ok');
  }
}

function wireControls(): void {
  for (const id of Object.keys(LANDFORMS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = LANDFORMS[id as keyof typeof LANDFORMS].name;
    $<HTMLSelectElement>('landform').appendChild(opt);
  }

  $<HTMLInputElement>('seed').addEventListener('change', (e) => {
    state.seed = Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1));
  });
  $<HTMLSelectElement>('landform').addEventListener('change', (e) => {
    state.landformId = (e.target as HTMLSelectElement).value as DemoState['landformId'];
  });
  $<HTMLInputElement>('resolution').addEventListener('input', (e) => {
    state.resolution = Number((e.target as HTMLInputElement).value);
    $<HTMLSpanElement>('res-value').textContent = `${state.resolution}²`;
  });
  $<HTMLInputElement>('erosion').addEventListener('input', (e) => {
    state.erosion = Number((e.target as HTMLInputElement).value);
    $<HTMLSpanElement>('erosion-value').textContent = `${(state.erosion * 100).toFixed(0)}%`;
  });
  $<HTMLButtonElement>('lock-river').addEventListener('click', () => {
    state.locks.riverbed = !state.locks.riverbed;
    updateLockChips();
  });
  $<HTMLButtonElement>('lock-pass').addEventListener('click', () => {
    state.locks.pass = !state.locks.pass;
    updateLockChips();
  });
  $<HTMLSelectElement>('preference').addEventListener('change', (e) => {
    state.repairPreference = (e.target as HTMLSelectElement).value as DemoState['repairPreference'];
  });
  $<HTMLButtonElement>('generate').addEventListener('click', () => void generate());
  $<HTMLButtonElement>('snapshot').addEventListener('click', saveSnapshot);
  $<HTMLButtonElement>('load-base').addEventListener('click', () => void loadBaseMap());
  $<HTMLButtonElement>('cam-overview').addEventListener('click', () => scene.setCameraPreset('overview'));
  $<HTMLButtonElement>('cam-trail').addEventListener('click', () => scene.setCameraPreset('trail'));
  $<HTMLButtonElement>('cam-regions').addEventListener('click', () => scene.setCameraPreset('regions'));
  $<HTMLButtonElement>('replay').addEventListener('click', () => {
    $<HTMLInputElement>('progress').value = '0';
    scene.setWalkProgress(0);
  });
  $<HTMLInputElement>('progress').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value) / 1000;
    scene.setWalkProgress(v);
    $<HTMLSpanElement>('progress-value').textContent = pct(v);
  });
  $<HTMLButtonElement>('export').addEventListener('click', () => {
    if (!current) return;
    const blob = new Blob([exportPackage(current)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ridgeline-${current.spec.seed}-${current.status}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $<HTMLButtonElement>('screenshot').addEventListener('click', () => {
    const url = scene.screenshot();
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ridgeline-view.png';
    a.click();
  });
  scene.onPick((p: Vec2) => {
    scene.focusOn(p);
  });
}

scenarioList();
syncInputs(buildSpec());
wireControls();
void generate();

// Expose for automated browser verification.
declare global {
  interface Window {
    __RIDGELINE__?: {
      generate: () => Promise<void>;
      state: typeof state;
      result: () => GenerationResult | null;
      scene: typeof scene;
    };
  }
}
window.__RIDGELINE__ = { generate, state, result: () => current, scene };
