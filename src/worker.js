// Simulation worker: owns the connectome and the LIF engine, streams spikes to the UI.
import { decodeConnectome, Brain } from './engine.js';
import { fetchSplit } from './loader.js';

let brain = null;
let running = true;
let speed = 1;                  // requested sim-ms per wall-ms
const drives = new Map();       // source -> [[idx[], hz], ...]
const silences = new Map();     // source -> idx[]
let motorOf = null, motorKeys = [], motorCounts = null;

let spikeBuf = new Uint32Array(1 << 16), nSpk = 0, dropped = 0;
let winCounts = null, winStart = 0;
let lastPost = 0, simAtPost = 0, simTarget = 0, lastWall = 0, stepsSincePost = 0, wallSincePost = 0;
const WINDOW_MS = 1000;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async ({ data: m }) => {
  if (m.type === 'init') return init(m);
  if (!brain) return;
  switch (m.type) {
    case 'drive': m.entries && m.entries.length ? drives.set(m.source, m.entries) : drives.delete(m.source); applyDrive(); break;
    case 'silence': m.idx && m.idx.length ? silences.set(m.source, m.idx) : silences.delete(m.source); applySilence(); break;
    case 'control':
      if (m.running !== undefined) running = m.running;
      if (m.speed !== undefined) speed = m.speed;
      simTarget = brain.time; lastWall = performance.now();
      break;
    case 'advance': advance(m.ms); break;
    case 'reset':
      brain.resetState(); winCounts.fill(0); winStart = 0; simTarget = 0; simAtPost = 0;
      applyDrive();
      break;
  }
};

async function init(m) {
  try {
    const bytes = await fetchSplit(m.url, (l, t) => post({ type: 'progress', phase: 'download', loaded: l, total: t }));
    post({ type: 'progress', phase: 'decode' });
    const t0 = performance.now();
    const graph = decodeConnectome(bytes);
    brain = new Brain(graph, {}, (Math.random() * 2 ** 31) | 0);
    motorKeys = Object.keys(m.motors);
    motorOf = new Int8Array(graph.N).fill(-1);
    motorKeys.forEach((k, j) => { for (const i of m.motors[k]) motorOf[i] = j; });
    motorCounts = new Float32Array(motorKeys.length);
    winCounts = new Uint16Array(graph.N);
    brain.onSpikes = onSpikes;
    post({ type: 'ready', N: graph.N, E: graph.E, decodeMs: performance.now() - t0 });
    lastWall = performance.now(); lastPost = lastWall;
    loop();
  } catch (e) {
    post({ type: 'error', message: String(e && e.message || e) });
  }
}

function applyDrive() {
  const map = new Map();
  for (const entries of drives.values())
    for (const [idx, hz] of entries) for (const i of idx) map.set(i, Math.max(map.get(i) || 0, hz));
  brain.setDrive(map);
}
function applySilence() {
  brain.clearSilenced();
  for (const idx of silences.values()) brain.setSilenced(idx, true);
}

function onSpikes(idx, n) {
  for (let s = 0; s < n; s++) {
    const i = idx[s];
    const mo = motorOf[i]; if (mo >= 0 && !brain.silenced[i]) motorCounts[mo]++;   // silenced = output synapses off
    if (winCounts[i] < 65535) winCounts[i]++;
    if (nSpk < spikeBuf.length) spikeBuf[nSpk++] = i;
    else if (spikeBuf.length < (1 << 21)) {
      const b = new Uint32Array(spikeBuf.length * 2); b.set(spikeBuf); spikeBuf = b; spikeBuf[nSpk++] = i;
    } else dropped++;
  }
}

const channel = new MessageChannel();
channel.port1.onmessage = tick;
function loop() { channel.port2.postMessage(0); }

function tick() {
  const now = performance.now();
  const wallDt = Math.min(now - lastWall, 100);
  lastWall = now;
  if (running) {
    simTarget += wallDt * speed;
    if (simTarget - brain.time > 150) simTarget = brain.time + 150;   // never build up a backlog
    const budgetEnd = now + 14;
    let steps = 0;
    while (brain.time < simTarget && (steps & 31 || performance.now() < budgetEnd)) { brain.step(); steps++; }
    stepsSincePost += steps;
    if (brain.time - winStart >= WINDOW_MS) postTop();
  } else {
    simTarget = brain.time;
  }
  wallSincePost += wallDt;
  if (now - lastPost >= 30) postFrame(now);
  if (!running) setTimeout(loop, 16);                 // idle while paused (no busy loop)
  else if (brain.time >= simTarget) setTimeout(loop, 2);
  else loop();
}

function postFrame(now, extra = {}) {
  const spikes = spikeBuf.slice(0, nSpk);
  post({
    type: 'frame', spikes, simTime: brain.time, dtSim: brain.time - simAtPost,
    motorCounts: Array.from(motorCounts), active: brain.nActive, dropped,
    speed: (brain.time - simAtPost) / Math.max(1, wallSincePost), running, ...extra,
  }, [spikes.buffer]);
  nSpk = 0; dropped = 0; motorCounts.fill(0);
  simAtPost = brain.time; lastPost = now; stepsSincePost = 0; wallSincePost = 0;
}

/** Deterministic stepping for scripted capture: advance exactly `ms` while paused. */
function advance(ms) {
  const target = brain.time + ms;
  while (brain.time < target - 1e-9) brain.step();
  if (brain.time - winStart >= WINDOW_MS) postTop();
  simTarget = brain.time;
  postFrame(performance.now(), { advanced: true });
}

function postTop() {
  const dur = (brain.time - winStart) / 1000;
  const driven = new Uint8Array(brain.N);
  for (const i of brain.stimList) driven[i] = 1;
  const top = [];
  let min = 0;
  for (let i = 0; i < brain.N; i++) {
    const c = winCounts[i];
    if (c <= min || driven[i]) continue;
    top.push([i, c]);
    if (top.length > 60) { top.sort((a, b) => b[1] - a[1]); top.length = 40; min = top[39][1]; }
  }
  top.sort((a, b) => b[1] - a[1]);
  let total = 0; for (let i = 0; i < brain.N; i++) total += winCounts[i];
  post({ type: 'top', list: top.slice(0, 40).map(([i, c]) => [i, c / dur]), totalRate: total / dur, windowMs: dur * 1000 });
  winCounts.fill(0); winStart = brain.time;
}
