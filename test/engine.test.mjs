import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain, decodeConnectome } from '../src/engine.js';

// build a CSR graph from an edge list [[pre, post, signedSynapses], ...]
function graphFrom(N, edges) {
  edges = [...edges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const rowptr = new Uint32Array(N + 1), col = new Uint32Array(edges.length), w = new Int16Array(edges.length);
  edges.forEach(([pre, post, s], e) => { rowptr[pre + 1]++; col[e] = post; w[e] = s; });
  for (let i = 0; i < N; i++) rowptr[i + 1] += rowptr[i];
  return { N, E: edges.length, rowptr, col, w };
}

test('Poisson drive makes a neuron fire at the requested rate', () => {
  const b = new Brain(graphFrom(1, []), {}, 7);
  b.setStim([0], 100);
  b.run(10000);
  const hz = b.spikeCount[0] / 10;
  assert.ok(Math.abs(hz - 100) < 6, `rate ${hz}`);
});

test('a silent network stays silent', () => {
  const b = new Brain(graphFrom(3, [[0, 1, 5], [1, 2, 5]]));
  b.run(500);
  assert.equal(b.spikeCount.reduce((a, c) => a + c, 0), 0);
});

test('synaptic delay is exactly 1.8 ms (18 steps)', () => {
  const b = new Brain(graphFrom(2, [[0, 1, 10]]));
  b._heat(0, -1); b.u[0] = 10;             // push neuron 0 above threshold
  let spikeStep = -1, arrival = -1;
  b.onSpikes = (idx, n, step) => { if (idx[0] === 0) spikeStep = step; };
  for (let s = 0; s < 60 && arrival < 0; s++) { b.step(); if (b.g[1] > 0) arrival = s; }
  assert.equal(spikeStep, 0);
  assert.equal(arrival - spikeStep, 18);
});

test('a strong synapse relays spikes', () => {
  const b = new Brain(graphFrom(2, [[0, 1, 200]]), {}, 3);
  b.setStim([0], 20);
  b.run(2000);
  assert.ok(b.spikeCount[0] > 20 && b.spikeCount[1] >= b.spikeCount[0] * 0.8, `${b.spikeCount[0]} -> ${b.spikeCount[1]}`);
});

test('inhibition blocks relay, silencing removes it', () => {
  const g = graphFrom(3, [[0, 2, 200], [1, 2, -400]]);
  const b = new Brain(g, {}, 5);
  b.setStim([0], 50); b.setStim([1], 200);
  b.run(1000);
  const inhibited = b.spikeCount[2];
  b.resetState(); b.setSilenced([1]);
  b.run(1000);
  assert.ok(b.spikeCount[2] > inhibited * 2 + 5, `${inhibited} -> ${b.spikeCount[2]}`);
});

test('lazy (event-driven) engine is spike-for-spike identical to dense stepping', () => {
  // random excitatory/inhibitory network with strong enough coupling to propagate activity
  let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  const N = 3000, edges = new Map();
  for (let e = 0; e < 90000; e++) {
    const pre = (rnd() * N) | 0, post = (rnd() * N) | 0;
    if (pre !== post) edges.set(pre * N + post, [pre, post, (pre % 5 === 0 ? -1 : 1) * (1 + ((rnd() * 12) | 0))]);
  }
  const g = graphFrom(N, [...edges.values()]);
  const run = (lazy) => { const b = new Brain(g, { lazy }, 99); b.setStim([...Array(40).keys()], 120); b.run(500); return b.spikeCount; };
  const dense = run(false), lazy = run(true);
  const total = dense.reduce((a, c) => a + c, 0);
  assert.ok(total > 1000, `network too quiet (${total})`);
  assert.deepEqual(Array.from(lazy), Array.from(dense));
});

test('connectome codec round-trips (varint + delta + zigzag)', () => {
  const enc = (v, out) => { do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); };
  const lens = [2, 0, 1], cols = [[1, 300000], [], [0]], ws = [[-3, 1897], [], [-2405]];
  const L = [], Cc = [], W = [];
  lens.forEach((l) => enc(l, L));
  cols.forEach((r) => { let p = 0; r.forEach((c) => { enc(c - p, Cc); p = c; }); });
  ws.flat().forEach((x) => enc(x >= 0 ? x * 2 : -x * 2 - 1, W));
  const head = new Uint8Array(28); head.set([70, 54, 55, 67]);   // "F67C"
  const dv = new DataView(head.buffer);
  [1, 3, 3, L.length, Cc.length, W.length].forEach((v, i) => dv.setUint32(4 + i * 4, v, true));
  const g = decodeConnectome(new Uint8Array([...head, ...L, ...Cc, ...W]));
  assert.deepEqual(Array.from(g.rowptr), [0, 2, 2, 3]);
  assert.deepEqual(Array.from(g.col), [1, 300000, 0]);
  assert.deepEqual(Array.from(g.w), [-3, 1897, -2405]);
});
