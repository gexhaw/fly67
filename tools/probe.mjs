// Command-line lab: activate / silence neuron sets in the v783 brain and print responses.
//   node tools/probe.mjs --on sugar:150 --on "type:DNp09:100" --off "type:SAD093" --ms 1000 --trials 3
//   node tools/probe.mjs --circuits          (runs the built-in behaviour checks)
import { writeFileSync } from 'node:fs';
import { Brain } from '../src/engine.js';
import { resolveCircuits } from '../src/circuits.js';
import { loadConnectome, loadNeurons } from './data-node.mjs';

const root = new URL('..', import.meta.url).pathname;
const neurons = loadNeurons();
const graph = loadConnectome();
const C = resolveCircuits(neurons);

function resolve(spec) {
  const [kind, name] = spec.split(/:(.+)/);
  if (kind === 'type') return neurons.select({ types: [name] });
  if (kind === 'prefix') return neurons.select({ typePrefix: [name] });
  if (kind === 'id') return neurons.select({ ids: [name] });
  if (C.sensors[kind]) return C.sensors[kind].idx;
  if (C.motors[kind]) return C.motors[kind].idx;
  throw new Error('unknown selector ' + spec);
}

export function experiment({ on = [], off = [], ms = 1000, trials = 3, seed = 1 }) {
  const brain = new Brain(graph, {}, seed);
  const counts = new Float64Array(graph.N);
  for (let t = 0; t < trials; t++) {
    brain.resetState(); brain.clearStim(); brain.clearSilenced();
    for (const [idx, hz] of on) brain.setStim(idx, hz);
    for (const idx of off) brain.setSilenced(idx);
    brain.run(ms);
    for (let i = 0; i < graph.N; i++) counts[i] += brain.spikeCount[i];
  }
  const rate = counts.map((c) => c / trials / (ms / 1000));
  const motors = Object.fromEntries(Object.entries(C.motors).map(([k, m]) => [k, +(m.idx.reduce((s, i) => s + rate[i], 0) / Math.max(1, m.idx.length)).toFixed(1)]));
  return { rate, motors };
}

function top(rate, exclude, n = 15) {
  const ex = new Set(exclude);
  return [...rate.keys()].filter((i) => rate[i] > 0 && !ex.has(i)).sort((a, b) => rate[b] - rate[a]).slice(0, n)
    .map((i) => `${neurons.label(i).padEnd(12)} ${neurons.sideOf(i).padEnd(6)} ${rate[i].toFixed(1).padStart(6)} Hz  ${neurons.ids[i]}`);
}

const args = process.argv.slice(2);
if (args.includes('--circuits')) {
  const S = C.sensors;
  const checks = [
    ['baseline (no input)', []],
    ['sugar 100 Hz', [[S.sugar.idx, 100]]],
    ['sugar 100 + bitter 150', [[S.sugar.idx, 100], [S.bitter.idx, 150]]],
    ['water 150 Hz', [[S.water.idx, 150]]],
    ['JO (C+E) left 150 Hz', [[S.joL.idx, 150]]],
    ['looming left 80 Hz', [[S.loomL.idx, 80]]],
    ['looming right 80 Hz', [[S.loomR.idx, 80]]],
  ];
  for (const k of Object.keys(C.sensors)) console.log(`sensor ${k}: ${C.sensors[k].idx.length} neurons`);
  for (const k of Object.keys(C.motors)) console.log(`motor ${k}: ${C.motors[k].idx.length} neurons`);
  const out = {};
  for (const [name, on] of checks) {
    const t = performance.now();
    const { motors } = experiment({ on, ms: 1000, trials: 3 });
    out[name] = motors;
    console.log(name.padEnd(26), JSON.stringify(motors), `${((performance.now() - t) / 1000).toFixed(1)}s`);
  }
  // expected, emergent behaviours (nothing below is wired by hand)
  const o = out;
  const expect = [
    ['sugar drives the proboscis motor neuron MN9', o['sugar 100 Hz'].mn9 > 20],
    ['bitter suppresses sugar-evoked MN9', o['sugar 100 + bitter 150'].mn9 < 0.3 * o['sugar 100 Hz'].mn9],
    ['antennal mechanosensation drives aDN1 grooming', o['JO (C+E) left 150 Hz'].groom > 5],
    ['looming drives the Giant Fiber (L)', o['looming left 80 Hz'].gf > 50],
    ['looming drives the Giant Fiber (R)', o['looming right 80 Hz'].gf > 50],
    ['looming from the left recruits right DNa02 (turn away)', o['looming left 80 Hz'].turnR > 3 * o['looming left 80 Hz'].turnL + 5],
    ['looming from the right recruits left DNa02 (turn away)', o['looming right 80 Hz'].turnL > 3 * o['looming right 80 Hz'].turnR + 5],
    ['no input, no output', Object.values(o['baseline (no input)']).every((v) => v === 0)],
  ];
  let ok = true;
  for (const [what, pass] of expect) { console.log(pass ? '  ✓' : '  ✗', what); ok &&= pass; }
  if (args.includes('--save')) writeFileSync(root + 'validation/circuits.json', JSON.stringify(out, null, 2));
  if (!ok) process.exit(1);
} else {
  const on = [], off = []; let ms = 1000, trials = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--on') { const s = args[++i]; const m = s.match(/^(.*):(\d+)$/); on.push([resolve(m[1]), +m[2]]); }
    else if (args[i] === '--off') off.push(resolve(args[++i]));
    else if (args[i] === '--ms') ms = +args[++i];
    else if (args[i] === '--trials') trials = +args[++i];
  }
  const { rate, motors } = experiment({ on, off, ms, trials });
  console.log('motors', motors);
  console.log(top(rate, on.flatMap((x) => x[0]), 25).join('\n'));
}
