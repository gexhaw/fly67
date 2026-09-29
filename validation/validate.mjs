// Validate the FLY67 engine against the original Brian2 implementation (Shiu et al. 2024).
//
// Reference A (primary): the authors' model.py run with Brian2 2.9 — see validation/run_brian2.py
// Reference B: results/example/sugarR*.parquet shipped with github.com/philshiu/Drosophila_brain_model
//              (older Brian2 release; its driven neurons fire ~200 Hz at 150 Hz drive, which the
//              current Brian2 and FLY67 do not reproduce — kept for transparency).
// FlyWire v630, 21 right labellar sugar GRNs, 1 s trials.
//
//   node validation/validate.mjs [trials]
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeConnectome, Brain } from '../src/engine.js';

const here = new URL('.', import.meta.url).pathname;
const trials = +(process.argv[2] || 30);
const SUGAR_R = [
  '720575940624963786', '720575940630233916', '720575940637568838', '720575940638202345', '720575940617000768',
  '720575940630797113', '720575940632889389', '720575940621754367', '720575940621502051', '720575940640649691',
  '720575940639332736', '720575940616885538', '720575940639198653', '720575940620900446', '720575940617937543',
  '720575940632425919', '720575940633143833', '720575940612670570', '720575940628853239', '720575940629176663',
  '720575940611875570',
];
const MN9 = '720575940660219265';

const t0 = performance.now();
const graph = decodeConnectome(gunzipSync(readFileSync(here + 'data/connectome_630.bin.gz')));
const ids = JSON.parse(readFileSync(here + 'data/ids_630.json', 'utf8'));
const idx = new Map(ids.map((id, i) => [id, i]));
const refs = {
  'brian2_2.9': JSON.parse(readFileSync(here + 'brian2_2.9_reference.json', 'utf8')),
  'published': JSON.parse(readFileSync(here + 'brian2_reference.json', 'utf8')),
};
console.log(`loaded N=${graph.N} E=${graph.E} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

function pearson(a, b) {
  const n = a.length; let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb);
}

const report = { trials, experiments: {} };
for (const [name, hz] of [['sugarR_150Hz', 150], ['sugarR_100Hz', 100]]) {
  const brain = new Brain(graph, {}, 42);
  const stim = SUGAR_R.map((id) => idx.get(id));
  const counts = new Float64Array(graph.N);
  const tStart = performance.now();
  for (let t = 0; t < trials; t++) {
    brain.resetState();
    brain.clearStim();
    brain.setStim(stim, hz);
    brain.run(1000);
    for (let i = 0; i < graph.N; i++) counts[i] += brain.spikeCount[i];
  }
  const wall = (performance.now() - tStart) / 1000;
  const mine = new Map();
  for (let i = 0; i < graph.N; i++) if (counts[i]) mine.set(ids[i], counts[i] / trials);

  const res = { stimHz: hz, fly67ActiveNeurons: mine.size, simSecondsPerWallSecond: +(trials / wall).toFixed(2) };
  for (const [refName, ref] of Object.entries(refs)) {
    const r = ref[name];
    const union = [...new Set([...Object.keys(r), ...mine.keys()])];
    const a = union.map((id) => r[id] || 0), b = union.map((id) => mine.get(id) || 0);
    const downstream = union.filter((id) => !SUGAR_R.includes(id));
    const a2 = downstream.map((id) => r[id] || 0), b2 = downstream.map((id) => mine.get(id) || 0);
    const top = (m) => [...m.entries()].filter(([id]) => !SUGAR_R.includes(id)).sort((x, y) => y[1] - x[1]).slice(0, 20).map((x) => x[0]);
    const topRef = top(new Map(Object.entries(r))), topMine = top(mine);
    let sa = 0, sb = 0; for (let i = 0; i < a2.length; i++) { sa += a2[i]; sb += b2[i]; }
    res[refName] = {
      activeNeurons: Object.keys(r).length,
      pearsonAll: +pearson(a, b).toFixed(4),
      pearsonDownstream: +pearson(a2, b2).toFixed(4),
      downstreamRateRatio: +(sb / sa).toFixed(3),
      top20Overlap: topRef.filter((id) => topMine.includes(id)).length,
      mn9Hz: { reference: +(r[MN9] || 0).toFixed(2), fly67: +(mine.get(MN9) || 0).toFixed(2) },
    };
  }
  report.experiments[name] = res;
  console.log(name, JSON.stringify(res));
}
writeFileSync(here + 'report.json', JSON.stringify(report, null, 2));
