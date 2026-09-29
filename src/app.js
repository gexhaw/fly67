import { decodeNeurons } from './neurons.js';
import { resolveCircuits } from './circuits.js';
import { BrainView, CLASS_COLORS } from './brain-view.js';
import { Arena } from './arena.js';
import { Arena3D } from './arena3d.js';
import { fetchBytes } from './loader.js';

const $ = (s) => document.querySelector(s);
const DATA = new URL('../data/', import.meta.url);
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const rgb = (c, a = 1) => `rgba(${c.map((x) => Math.round(Math.min(1, x) * 255)).join(',')},${a})`;

const MOTOR_STYLE = {
  mn9:   { max: 120, color: '#ffd166', what: 'feeding' },
  groom: { max: 60,  color: '#b98cff', what: 'grooming' },
  gf:    { max: 200, color: '#ff5d6c', what: 'escape' },
  back:  { max: 60,  color: '#ff9f6b', what: 'backward' },
  walkL: { max: 120, color: '#5ef0c6', what: 'forward' },
  walkR: { max: 120, color: '#5ef0c6', what: 'forward' },
  turnL: { max: 80,  color: '#7aa2ff', what: 'turn left' },
  turnR: { max: 80,  color: '#7aa2ff', what: 'turn right' },
};

let neurons, circuits, brainView, arena, arena3d, worker;
let running = true;
let motorKeys = [], motorHz = {};
const labManips = [];
let manipId = 0;
let selected = -1, selectedRate = 0, selectedSpikes = 0;
const popHist = [];
let popClasses = [];
let lastSent = { world: '', walk: '' };

boot().catch((e) => { $('#load-msg').textContent = 'Error: ' + e.message; console.error(e); });

async function boot() {
  $('#load-msg').textContent = 'loading neuron annotations…';
  const [meta, nbytes] = await Promise.all([
    fetch(new URL('neurons.json', DATA)).then((r) => r.json()),
    fetchBytes(new URL('neurons.bin.gz', DATA)),
  ]);
  neurons = decodeNeurons(nbytes, meta);
  circuits = resolveCircuits(neurons);
  $('#st-neurons').textContent = neurons.N.toLocaleString('en');
  $('#st-edges').textContent = fmt(meta.E);

  brainView = new BrainView($('#brain'), neurons);
  brainView.onPick = (i) => select(i);
  try {
    arena = new Arena();
    arena3d = new Arena3D($('#arena'), arena);
  } catch (e) {                                   // no WebGL for a second context: fall back to the 2D arena
    console.warn('3D arena unavailable, using 2D', e);
    arena = new Arena($('#arena')); arena3d = null;
  }
  arena.onEvent = (name, t) => {
    const el = $('#fly-state');
    el.textContent = name === 'escape' ? 'escape takeoff!' : name === 'six seven' ? '6 🤲 7' : name;
    el.className = 'state ' + name;
    if (['escape', 'feeding', 'grooming', 'backing up', 'landed', 'six seven'].includes(name)) log(t, `<b>${name === 'six seven' ? '6-7 🤲' : name}</b> ${explain(name)}`);
  };
  buildLegend(); buildMotorBars(); buildUI();

  motorKeys = Object.keys(circuits.motors);
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorker;
  worker.postMessage({
    type: 'init', url: new URL('connectome.json', DATA).href,
    motors: Object.fromEntries(motorKeys.map((k) => [k, circuits.motors[k].idx])),
  });
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ worker I/O
function onWorker({ data: m }) {
  if (m.type === 'progress') {
    if (m.phase === 'download') {
      const p = m.total ? m.loaded / m.total : 0;
      $('#load-bar').style.width = (p * 90).toFixed(1) + '%';
      $('#load-msg').textContent = `downloading synapses… ${(m.loaded / 1e6).toFixed(1)}${m.total ? ' / ' + (m.total / 1e6).toFixed(1) : ''} MB`;
    } else {
      $('#load-bar').style.width = '95%';
      $('#load-msg').textContent = 'decoding 15 million connections…';
    }
  } else if (m.type === 'ready') {
    $('#load-bar').style.width = '100%';
    setTimeout(() => $('#loading').classList.add('done'), 200);
    sendWalk();
    log(0, `<b>brain online</b> ${neurons.N.toLocaleString('en')} neurons, ${m.E.toLocaleString('en')} connections`);
  } else if (m.type === 'error') {
    $('#load-msg').textContent = 'Error: ' + m.message;
  } else if (m.type === 'frame') {
    onFrame(m);
  } else if (m.type === 'top') {
    renderTop(m);
  }
}

let advanceResolve = null;
function onFrame(m) {
  const { spikes, dtSim } = m;
  brainView.spikes(spikes, spikes.length);
  // population activity by super class
  const counts = new Float32Array(neurons.meta.superClasses.length);
  const sc = neurons.superClass;
  for (let s = 0; s < spikes.length; s++) counts[sc[spikes[s]]]++;
  if (dtSim > 0) {
    popHist.push(Array.from(counts, (c) => c / (dtSim / 1000)));
    if (popHist.length > 360) popHist.shift();
    motorKeys.forEach((k, j) => { motorHz[k] = m.motorCounts[j] / Math.max(1, circuits.motors[k].idx.length) / (dtSim / 1000); });
    arena.update(dtSim, motorHz);
    if (selected >= 0) {
      let c = 0; for (let s = 0; s < spikes.length; s++) if (spikes[s] === selected) c++;
      selectedSpikes += c;
      selectedRate += (c / (dtSim / 1000) - selectedRate) * (1 - Math.exp(-dtSim / 300));
    }
  }
  sendWorld();
  if (m.advanced && advanceResolve) { const r = advanceResolve; advanceResolve = null; r(m.simTime); }
  $('#st-time').textContent = (m.simTime / 1000).toFixed(2) + ' s';
  $('#st-speed').textContent = manual ? '1.00×' : m.running ? m.speed.toFixed(2) + '×' : 'paused';
  $('#st-active').textContent = fmt(m.active);
  const tot = dtSim > 0 ? spikes.length / (dtSim / 1000) : 0;
  const el = $('#st-rate'); el.dataset.v = (+(el.dataset.v || 0) * 0.85 + tot * 0.15); el.textContent = fmt(+el.dataset.v);
}

function sendWorld() {
  const s = arena.sense();
  const entries = [];
  for (const [k, hz] of Object.entries(s)) if (hz > 0) entries.push([circuits.sensors[k].idx, Math.round(hz / 5) * 5]);
  const key = Object.entries(s).map(([k, v]) => k + (Math.round(v / 5) * 5)).join();
  if (key === lastSent.world) return;
  lastSent.world = key;
  worker.postMessage({ type: 'drive', source: 'world', entries });
  const on = Object.entries(s).filter(([, v]) => v > 0).map(([k]) => circuits.sensors[k].label).join(', ');
  if (on !== lastSent.worldLog) { lastSent.worldLog = on; if (on) log(arena.simT, `sensory input → <b>${on}</b>`); }
}
function sendWalk() {
  const hz = +$('#walk').value;
  $('#walk-val').textContent = hz + ' Hz';
  worker.postMessage({ type: 'drive', source: 'walk', entries: hz ? [[[...circuits.motors.walkL.idx, ...circuits.motors.walkR.idx], hz]] : [] });
}
function sendLab() {
  worker.postMessage({ type: 'drive', source: 'lab', entries: labManips.filter((x) => x.mode === 'activate').map((x) => [x.idx, x.hz]) });
  worker.postMessage({ type: 'silence', source: 'lab', idx: labManips.filter((x) => x.mode === 'silence').flatMap((x) => x.idx) });
  brainView.setFlags(labManips.filter((x) => x.mode === 'activate').flatMap((x) => x.idx), labManips.filter((x) => x.mode === 'silence').flatMap((x) => x.idx));
  renderManips();
}

// ------------------------------------------------------------------ render loop
let lastT = performance.now();
let manual = false;           // scripted capture: the page is drawn only via fly67.render()
function render(t, dt) {
  brainView.draw(dt);
  if (arena3d) arena3d.draw(t); else arena.draw(t);
  drawPop();
  updateMotorBars();
  if (selected >= 0) updateInspectorRate();
}
function frame(t) {
  const dt = Math.min(64, t - lastT); lastT = t;
  if (!manual) render(t, dt);
  requestAnimationFrame(frame);
}

// Scripting hook — used by tools/capture.py to record deterministic GIFs; handy in the console too.
window.fly67 = {
  get neurons() { return neurons; }, get circuits() { return circuits; },
  get arena() { return arena; }, get arena3d() { return arena3d; }, get brainView() { return brainView; },
  scenario: (s) => scenario(s),
  /** Pause real time and take over rendering. */
  manual(on = true) { manual = on; running = !on; worker.postMessage({ type: 'control', running }); },
  /** Advance the brain by exactly `ms` of simulated time; resolves once the UI has processed it. */
  advance(ms) { return new Promise((r) => { advanceResolve = r; worker.postMessage({ type: 'advance', ms }); }); },
  render,
};

// ------------------------------------------------------------------ UI pieces
function buildLegend() {
  const counts = new Map();
  for (let i = 0; i < neurons.N; i++) { const n = neurons.meta.superClasses[neurons.superClass[i]]; counts.set(n, (counts.get(n) || 0) + 1); }
  const rows = [...counts.entries()].filter(([n]) => n !== 'unknown').sort((a, b) => b[1] - a[1]);
  $('#legend').innerHTML = rows.map(([n, c]) => `<span><i style="color:${rgb(CLASS_COLORS[n] || [.5, .5, .5])};background:currentColor"></i>${n.replace(/_/g, ' ')} <b style="opacity:.55;font-weight:400">${fmt(c)}</b></span>`).join('');
  popClasses = ['sensory', 'optic', 'visual_projection', 'central', 'descending', 'motor'].map((n) => neurons.meta.superClasses.indexOf(n)).filter((i) => i >= 0);
}

function drawPop() {
  const c = $('#pop'), ctx = c.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  ctx.clearRect(0, 0, w, h);
  const n = popHist.length; if (n < 2) return;
  const names = neurons.meta.superClasses;
  const pad = 8 * dpr, lw = 120 * dpr;
  let max = 10;
  for (const row of popHist) for (const j of popClasses) max = Math.max(max, row[j]);
  const y = (v) => h - pad - Math.sqrt(v / max) * (h - pad * 2);
  popClasses.forEach((j, k) => {
    const col = CLASS_COLORS[names[j]] || [.6, .6, .6];
    ctx.strokeStyle = rgb(col, 0.9); ctx.lineWidth = 1.3 * dpr; ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = lw + (i / 359) * (w - lw - pad); i ? ctx.lineTo(x, y(popHist[i][j])) : ctx.moveTo(x, y(popHist[i][j])); }
    ctx.stroke();
    const last = popHist[n - 1][j];
    ctx.fillStyle = rgb(col, 0.95); ctx.font = `${10 * dpr}px JetBrains Mono, monospace`;
    ctx.fillText(`${names[j].replace('visual_projection', 'vis. proj.').slice(0, 11).padEnd(11)} ${fmt(last).padStart(5)}/s`, pad, pad + 10 * dpr + k * 13 * dpr);
  });
}

function buildMotorBars() {
  const order = ['mn9', 'groom', 'gf', 'back', 'walkL', 'walkR', 'turnL', 'turnR'];
  $('#motor-bars').innerHTML = order.map((k) => {
    const m = circuits.motors[k], st = MOTOR_STYLE[k];
    return `<div class="mbar" data-k="${k}" title="${m.idx.length} neuron(s) · click to inspect"><div class="lbl"><b>${m.label}</b><span>0 Hz</span></div><div class="track"><div class="fill" style="background:${st.color};box-shadow:0 0 8px ${st.color}"></div></div></div>`;
  }).join('');
  $('#motor-bars').querySelectorAll('.mbar').forEach((el) => el.addEventListener('click', () => select(circuits.motors[el.dataset.k].idx[0])));
}
function updateMotorBars() {
  if (!arena) return;
  $('#motor-bars').querySelectorAll('.mbar').forEach((el) => {
    const k = el.dataset.k, v = arena.motor[k] || 0;
    el.querySelector('span').textContent = v.toFixed(0) + ' Hz';
    el.querySelector('.fill').style.width = Math.min(100, v / MOTOR_STYLE[k].max * 100) + '%';
  });
}

function explain(name) {
  const m = arena.motor;
  if (name === 'feeding') return `— MN9 at ${m.mn9.toFixed(0)} Hz extends the proboscis`;
  if (name === 'grooming') return `— aDN1 at ${m.groom.toFixed(0)} Hz, front legs sweep the antennae`;
  if (name === 'escape') return `— Giant Fiber at ${m.gf.toFixed(0)} Hz, takeoff`;
  if (name === 'six seven') return '— meme gesture (scripted easter egg, not from the connectome)';
  if (name === 'backing up') return `— MDN (moonwalker) at ${m.back.toFixed(0)} Hz`;
  return '';
}
function log(t, html) {
  const el = $('#log');
  const d = document.createElement('div');
  d.innerHTML = `<span class="t">${(t / 1000).toFixed(2)}s</span>${html}`;
  el.prepend(d);
  while (el.children.length > 60) el.lastChild.remove();
}

function buildUI() {
  // camera
  document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-cam]').forEach((x) => x.classList.toggle('on', x === b));
    if (arena3d) arena3d.setMode(b.dataset.cam);
  }));
  // tools
  $('#tools').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $('#tools').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    arena.tool = b.dataset.tool;
  });
  $('#walk').addEventListener('input', sendWalk);
  // tabs
  document.querySelectorAll('.tabs nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs nav button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  }));
  // controls
  const setRunning = (r) => { running = r; worker.postMessage({ type: 'control', running }); $('#btn-play').textContent = running ? '❚❚' : '▶'; };
  $('#btn-play').addEventListener('click', () => setRunning(!running));
  addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setRunning(!running); } });
  $('#sel-speed').addEventListener('change', (e) => worker.postMessage({ type: 'control', speed: +e.target.value }));
  $('#btn-reset').addEventListener('click', () => { worker.postMessage({ type: 'reset' }); brainView.act.fill(0); log(arena.simT, '<b>reset</b> membrane state cleared'); });
  // scenarios
  document.querySelectorAll('[data-scen]').forEach((b) => b.addEventListener('click', () => scenario(b.dataset.scen)));
  // lab search
  $('#search').addEventListener('input', renderResults);
}

function holdStill() {
  // like a tethered-fly experiment: stop the external walking drive so the fly stays on the stimulus
  if (+$('#walk').value !== 0) { $('#walk').value = 0; sendWalk(); log(arena.simT, 'walking drive → 0 Hz (fly held still for the experiment)'); }
}

function scenario(s) {
  const t = arena.simT;
  if (s === 'sugar' || s === 'bitter' || s === 'antenna') holdStill();
  if (s === 'sugar') { arena.placeFoodAhead('sugar'); log(t, '<b>experiment</b> sugar drop under the proboscis'); }
  if (s === 'bitter') { arena.placeFoodAhead('sugar'); arena.placeFoodAhead('bitter'); log(t, '<b>experiment</b> sugar + bitter on the same spot'); }
  if (s === 'antenna') { arena.touchAntenna(Math.random() < 0.5 ? 'L' : 'R'); log(t, '<b>experiment</b> air puff on an antenna'); }
  if (s === 'loomL' || s === 'loomR') { arena.loomFrom(s === 'loomL' ? 'L' : 'R'); log(t, `<b>experiment</b> looming object from the ${s === 'loomL' ? 'left' : 'right'}`); }
  if (s === 'six') { arena.sixSeven(); log(t, '<b>experiment</b> six seven, on demand'); }
  if (s === 'noGF') {
    if (!labManips.some((x) => x.key === 'noGF')) addManip({ key: 'noGF', label: 'DNp01 (Giant Fiber)', idx: circuits.motors.gf.idx, mode: 'silence' });
    arena.loomFrom('L');
    log(t, '<b>experiment</b> Giant Fiber silenced, threat from the left');
    document.querySelector('[data-tab=lab]').click();
  }
}

// ------------------------------------------------------------------ lab
function renderResults() {
  const q = $('#search').value;
  const res = neurons.search(q, 25);
  $('#results').innerHTML = res.map((r, j) => `<div class="res" data-j="${j}"><span>${r.label}<span class="n">${r.indices.length} n</span></span><span class="acts"><button class="btn go" data-a="activate">Activate</button><button class="btn stop" data-a="silence">Silence</button><button class="btn" data-a="show">Show</button></span></div>`).join('')
    || (q ? '<p class="muted small">no match</p>' : '');
  $('#results').querySelectorAll('.res').forEach((el) => el.addEventListener('click', (e) => {
    const r = res[+el.dataset.j], a = e.target.dataset.a;
    if (a === 'show') { select(r.indices[0]); return; }
    if (a) addManip({ label: r.label, idx: r.indices, mode: a });
  }));
}
function addManip(m) {
  labManips.push({ id: ++manipId, hz: 150, ...m });
  log(arena.simT, `<b>${m.mode}</b> ${m.label} (${m.idx.length} neuron${m.idx.length > 1 ? 's' : ''})`);
  sendLab();
}
function renderManips() {
  const el = $('#manips');
  el.innerHTML = labManips.length ? labManips.map((m) => m.mode === 'activate'
    ? `<div class="manip activate" data-id="${m.id}"><span>⚡ ${m.label} <span class="muted">· ${m.idx.length}</span></span><input type="range" min="10" max="250" step="10" value="${m.hz}"><output>${m.hz} Hz</output><button class="x" title="remove">✕</button></div>`
    : `<div class="manip silence" data-id="${m.id}"><span>⦸ ${m.label} <span class="muted">· ${m.idx.length}</span></span><span class="muted small">silenced</span><button class="x" title="remove">✕</button></div>`).join('')
    : '<p class="muted small">Activate neurons with Poisson drive (like CsChrimson) or silence their output synapses (like Kir2.1). Try: activate <b>LC4</b>, silence <b>DNp01</b>, activate <b>MDN</b>, activate <b>ORN_DA2</b>.</p>';
  el.querySelectorAll('.manip').forEach((row) => {
    const m = labManips.find((x) => x.id === +row.dataset.id);
    row.querySelector('.x').onclick = () => { labManips.splice(labManips.indexOf(m), 1); sendLab(); };
    const r = row.querySelector('input');
    if (r) r.oninput = () => { m.hz = +r.value; row.querySelector('output').textContent = m.hz + ' Hz'; clearTimeout(m._t); m._t = setTimeout(sendLab, 80); };
  });
}

function renderTop(m) {
  const tb = $('#top tbody');
  tb.innerHTML = m.list.slice(0, 30).map(([i, r]) => {
    const col = CLASS_COLORS[neurons.superClassOf(i)] || [.5, .5, .5];
    return `<tr data-i="${i}"><td><span class="cls" style="background:${rgb(col)}"></span>${neurons.label(i)}</td><td class="muted">${neurons.sideOf(i)}</td><td class="muted">${neurons.superClassOf(i).replace(/_/g, ' ')}</td><td class="r">${r.toFixed(0)} Hz</td></tr>`;
  }).join('') || '<tr><td class="muted">no activity yet — try an experiment</td></tr>';
  tb.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => select(+tr.dataset.i)));
}

// ------------------------------------------------------------------ inspector
function select(i) {
  selected = i; selectedRate = 0; selectedSpikes = 0;
  brainView.selected = i;
  sendLabFlagsOnly();
  const el = $('#inspector');
  if (i < 0) { el.classList.add('hidden'); return; }
  const type = neurons.typeOf(i);
  const siblings = type ? neurons.byType.get(type) : [i];
  el.classList.remove('hidden');
  el.innerHTML = `<button class="close">✕</button>
    <h3>${neurons.label(i)}</h3>
    <div class="muted">${neurons.superClassOf(i).replace(/_/g, ' ')}${neurons.classOf(i) ? ' · ' + neurons.classOf(i) : ''}</div>
    <div class="kv">
      <div>side</div><div>${neurons.sideOf(i) || '—'}</div>
      <div>transmitter</div><div>${neurons.ntOf(i) || '—'}</div>
      <div>inputs / outputs</div><div class="mono">${neurons.inDeg[i]} / ${neurons.outDeg[i]} partners</div>
      <div>firing</div><div class="mono" id="insp-rate">0 Hz</div>
      <div>FlyWire ID</div><div class="mono small"><a href="https://codex.flywire.ai/app/cell_details?root_id=${neurons.ids[i]}&data_version=783" target="_blank" rel="noopener">${neurons.ids[i]}</a></div>
    </div>
    <div class="row">
      <button class="btn go" data-a="activate">Activate ${siblings.length > 1 ? 'type (' + siblings.length + ')' : ''}</button>
      <button class="btn stop" data-a="silence">Silence ${siblings.length > 1 ? 'type' : ''}</button>
      ${siblings.length > 1 ? '<button class="btn go" data-a="one">Activate this one</button>' : ''}
    </div>`;
  el.querySelector('.close').onclick = () => select(-1);
  el.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
    const a = b.dataset.a;
    if (a === 'one') addManip({ label: `${neurons.label(i)} #${neurons.ids[i].slice(-5)}`, idx: [i], mode: 'activate' });
    else addManip({ label: type || neurons.label(i), idx: siblings, mode: a });
  });
}
function sendLabFlagsOnly() {
  brainView.setFlags(labManips.filter((x) => x.mode === 'activate').flatMap((x) => x.idx), labManips.filter((x) => x.mode === 'silence').flatMap((x) => x.idx));
}
function updateInspectorRate() {
  const el = document.getElementById('insp-rate');
  if (el) el.textContent = `${selectedRate.toFixed(1)} Hz · ${selectedSpikes} spikes`;
}
