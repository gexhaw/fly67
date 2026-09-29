// The lazy (event-driven) engine must reproduce the dense reference stepping.
// Same seed, same stimulus: compare every neuron's spike count over 1 s.
//   node validation/lazy_vs_dense.mjs
import { Brain } from '../src/engine.js';
import { resolveCircuits } from '../src/circuits.js';
import { loadConnectome, loadNeurons } from '../tools/data-node.mjs';

const neurons = loadNeurons();
const graph = loadConnectome();
const C = resolveCircuits(neurons);

for (const [name, sensors, hz] of [['sugar', ['sugar'], 150], ['looming L', ['loomL'], 80], ['JO L', ['joL'], 150]]) {
  const res = {};
  for (const lazy of [false, true]) {
    const b = new Brain(graph, { lazy }, 123);
    for (const s of sensors) b.setStim(C.sensors[s].idx, hz);
    const t = performance.now();
    b.run(1000);
    res[lazy ? 'lazy' : 'dense'] = { counts: b.spikeCount.slice(), wall: (performance.now() - t) / 1000 };
  }
  const a = res.dense.counts, l = res.lazy.counts;
  let same = 0, diff = 0, tot = 0, absd = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] || l[i]) { a[i] === l[i] ? same++ : diff++; } tot += a[i]; absd += Math.abs(a[i] - l[i]); }
  console.log(`${name.padEnd(10)} spiking neurons identical: ${same}/${same + diff}  total spikes ${tot}  |Δ| ${absd}  ` +
    `dense ${res.dense.wall.toFixed(2)}s  lazy ${res.lazy.wall.toFixed(2)}s  speed-up ×${(res.dense.wall / res.lazy.wall).toFixed(1)}`);
}
