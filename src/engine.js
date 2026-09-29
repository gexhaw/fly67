// FLY67 — leaky integrate-and-fire engine for the whole Drosophila brain.
// Re-implementation of the Shiu et al. (Nature 2024) model, no dependencies.
// Runs in browsers (Web Worker) and Node.js.
//
// Speed trick: the sub-threshold dynamics are linear, so a neuron that provably cannot reach
// threshold before its next input is not integrated at all ("cold"). Its state is advanced
// analytically (exact exponential solution) only when a spike arrives. Only "hot" neurons —
// close to threshold, refractory or externally driven — are stepped every 0.1 ms.
// The result is identical to stepping all 138k neurons (validation/validate.mjs).

export const DEFAULT_PARAMS = Object.freeze({
  dt: 0.1,      // ms, integration step (same as Brian2 default in the paper)
  v0: -52,      // mV resting potential
  vReset: -52,  // mV reset potential
  vTh: -45,     // mV threshold
  tMbr: 20,     // ms membrane time constant
  tau: 5,       // ms synaptic time constant
  tRfc: 2.2,    // ms refractory period
  tDly: 1.8,    // ms synaptic delay
  wSyn: 0.275,  // mV per synapse
  fPoi: 250,    // Poisson kick = wSyn * fPoi  (enough for an immediate spike)
  lazy: true,   // false = step every touched neuron every dt (reference mode, ~10x slower)
});

// ---------------------------------------------------------------- decoding
function readVarints(u8, pos, count, out) {
  let p = pos;
  for (let i = 0; i < count; i++) {
    let b = u8[p++], v = b & 0x7f;
    if (b & 0x80) {
      b = u8[p++]; v |= (b & 0x7f) << 7;
      if (b & 0x80) {
        b = u8[p++]; v |= (b & 0x7f) << 14;
        if (b & 0x80) {
          b = u8[p++]; v |= (b & 0x7f) << 21;
          if (b & 0x80) { b = u8[p++]; v += (b & 0x7f) * 268435456; }
        }
      }
    }
    out[i] = v;
  }
  return p;
}

/** Decode `connectome.bin` (already gunzipped) into CSR arrays. */
export function decodeConnectome(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'F67C') throw new Error('not a FLY67 connectome file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const N = dv.getUint32(8, true), E = dv.getUint32(12, true);
  let p = 28;
  const lens = new Uint32Array(N);
  p = readVarints(u8, p, N, lens);
  const rowptr = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) rowptr[i + 1] = rowptr[i] + lens[i];
  const col = new Uint32Array(E);
  p = readVarints(u8, p, E, col);
  for (let i = 0; i < N; i++) {           // undo delta coding
    let acc = 0;
    for (let e = rowptr[i]; e < rowptr[i + 1]; e++) { acc += col[e]; col[e] = acc; }
  }
  const zz = new Uint32Array(E);
  readVarints(u8, p, E, zz);
  const w = new Int16Array(E);
  for (let e = 0; e < E; e++) { const z = zz[e]; w[e] = (z >>> 1) ^ -(z & 1); }
  return { N, E, rowptr, col, w };
}

// ---------------------------------------------------------------- rng
function xorshift128(seed) {
  let a = seed >>> 0 || 1, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const next = () => {
    const t = a ^ (a << 11);
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return d / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

// ---------------------------------------------------------------- engine
const TABLE = 8192;   // lazy-decay lookup length (819 ms; beyond that the state is ~0)

export class Brain {
  constructor(graph, params = {}, seed = 1) {
    this.g_ = graph;
    this.N = graph.N;
    this.p = { ...DEFAULT_PARAMS, ...params };
    const { dt, tMbr, tau, tRfc, tDly, vTh, v0 } = this.p;
    this.decayV = Math.exp(-dt / tMbr);
    this.decayG = Math.exp(-dt / tau);
    this.gToV = (tau / (tau - tMbr)) * (this.decayG - this.decayV);
    // k-step exact propagators: u(k) = u*A[k] + g*C[k], g(k) = g*B[k]
    this.A = new Float64Array(TABLE); this.B = new Float64Array(TABLE); this.C = new Float64Array(TABLE);
    for (let k = 0; k < TABLE; k++) {
      this.A[k] = Math.exp(-k * dt / tMbr); this.B[k] = Math.exp(-k * dt / tau);
      this.C[k] = (tau / (tau - tMbr)) * (this.B[k] - this.A[k]);
    }
    // max over t of C(t): the largest voltage a unit of synaptic current can still produce
    let cmax = 0; for (let k = 0; k < TABLE; k++) cmax = Math.max(cmax, this.C[k]);
    this.cMax = cmax * 1.0001;
    this.theta = vTh - v0;                            // mV above rest
    this.lazy = this.p.lazy;
    this.rfcSteps = Math.round(tRfc / dt);
    this.D = Math.round(tDly / dt);
    this.kick = this.p.wSyn * this.p.fPoi;
    this.rand = xorshift128(seed);

    const N = this.N;
    this.u = new Float32Array(N);                    // v - v0 (mV)
    this.g = new Float32Array(N);                    // synaptic drive (mV)
    this.upd = new Int32Array(N);                    // step at which (u, g) of a cold neuron is valid
    this.lastSpike = new Int32Array(N).fill(-1e9);
    this.rfc = new Uint8Array(N).fill(this.rfcSteps);
    this.silenced = new Uint8Array(N);
    this.stimRate = new Float32Array(N);             // Hz
    this.stimList = [];

    this.active = new Int32Array(N);                 // hot list
    this.nActive = 0;
    this.inActive = new Uint8Array(N);

    this.ring = [];
    for (let k = 0; k < this.D; k++) this.ring.push({ n: 0, idx: new Int32Array(1024) });
    this.fired = new Int32Array(1024); this.nFired = 0;

    this.spikeCount = new Uint32Array(N);
    this.step_ = 0;
    this.onSpikes = null;   // optional (Int32Array view, count, step) => void
  }

  get time() { return this.step_ * this.p.dt; }       // ms

  /** Membrane potential in mV (advances a cold neuron lazily; read-only helper). */
  voltage(i) {
    if (this.inActive[i]) return this.p.v0 + this.u[i];
    const k = Math.min(this.step_ - 1 - this.upd[i], TABLE - 1);
    return this.p.v0 + (k <= 0 ? this.u[i] : this.u[i] * this.A[k] + this.g[i] * this.C[k]);
  }

  // ---- manipulation -----------------------------------------------------
  /** Poisson drive (optogenetic-style activation). rate in Hz, 0 removes. */
  setStim(indices, rateHz) {
    const m = new Map(this.stimList.map((i) => [i, this.stimRate[i]]));
    for (const i of indices) { if (rateHz > 0) m.set(i, rateHz); else m.delete(i); }
    this.setDrive(m);
  }
  /** Replace the whole drive at once: Map(index -> Hz). O(changed neurons). */
  setDrive(map) {
    for (const i of this.stimList) { this.stimRate[i] = 0; this.rfc[i] = this.rfcSteps; }
    const list = [];
    for (const [i, hz] of map) {
      if (!(hz > 0)) continue;
      this.stimRate[i] = hz;
      this.rfc[i] = 0;             // as in the paper: no refractoriness for driven neurons
      list.push(i);
      this._heat(i, this.step_ - 1);
    }
    this.stimList = list;
  }
  clearStim() { this.setDrive(new Map()); }
  /** Silencing = all outgoing synapses of these neurons set to 0 (as in the paper). */
  setSilenced(indices, on = true) { for (const i of indices) this.silenced[i] = on ? 1 : 0; }
  clearSilenced() { this.silenced.fill(0); }

  resetState() {
    this.u.fill(0); this.g.fill(0); this.upd.fill(0); this.lastSpike.fill(-1e9);
    this.inActive.fill(0); this.nActive = 0;
    for (const r of this.ring) r.n = 0;
    this.spikeCount.fill(0);
    this.step_ = 0;
    for (const i of this.stimList) this._heat(i, -1);
  }
  resetCounts() { this.spikeCount.fill(0); }

  /** Bring a cold neuron's state up to step n and put it on the hot list. */
  _heat(i, n) {
    if (this.inActive[i]) return;
    const k = n - this.upd[i];
    if (k > 0) {
      if (k >= TABLE) { this.u[i] = 0; this.g[i] = 0; }
      else { const u = this.u[i], g = this.g[i]; this.u[i] = u * this.A[k] + g * this.C[k]; this.g[i] = g * this.B[k]; }
    }
    this.inActive[i] = 1; this.active[this.nActive++] = i;
  }

  // ---- main loop ---------------------------------------------------------
  step() {
    const n = this.step_;
    const u = this.u, g = this.g, ls = this.lastSpike, rfc = this.rfc, upd = this.upd;
    const dV = this.decayV, dG = this.decayG, gv = this.gToV, theta = this.theta, cMax = this.cMax, lazy = this.lazy;
    const active = this.active, inActive = this.inActive, stimRate = this.stimRate;
    let fired = this.fired, nf = 0;

    // 1+2. integrate hot neurons and test threshold; demote the ones that cannot fire anymore
    let k = 0;
    while (k < this.nActive) {
      const i = active[k];
      if (n - ls[i] >= rfc[i]) {
        const ui = u[i], gi = g[i];
        const un = ui * dV + gi * gv, gn = gi * dG;
        u[i] = un; g[i] = gn;
        if (un > theta) {
          if (nf === fired.length) { const f2 = new Int32Array(nf * 2); f2.set(fired); fired = this.fired = f2; }
          fired[nf++] = i;
        } else if (lazy && (un > 0 ? un : 0) + (gn > 0 ? gn * cMax : 0) < theta && stimRate[i] === 0) {
          inActive[i] = 0; upd[i] = n;                  // provably sub-threshold: go cold
          active[k] = active[--this.nActive];
          continue;
        }
      }
      k++;
    }

    // 3a. deliver spikes emitted D steps ago
    const slot = this.ring[n % this.D];
    if (slot.n) {
      const { rowptr, col, w } = this.g_;
      const ws = this.p.wSyn, sil = this.silenced, idx = slot.idx, A = this.A, B = this.B, C = this.C;
      for (let s = 0; s < slot.n; s++) {
        const pre = idx[s];
        if (sil[pre]) continue;
        for (let e = rowptr[pre], end = rowptr[pre + 1]; e < end; e++) {
          const post = col[e];
          if (inActive[post]) {
            // Brian2 semantics: `g` is "unless refractory", so input arriving during the
            // refractory period is discarded (conditional write on not_refractory)
            if (n - ls[post] >= rfc[post]) g[post] += w[e] * ws;
            continue;
          }
          // cold: advance exactly to step n, add input, maybe promote
          let uu = u[post], gg = g[post];
          const dk = n - upd[post];
          if (dk > 0) {
            if (dk >= TABLE) { uu = 0; gg = 0; }
            else { uu = uu * A[dk] + gg * C[dk]; gg *= B[dk]; }
          }
          gg += w[e] * ws;
          u[post] = uu; g[post] = gg; upd[post] = n;
          if (!lazy || (uu > 0 ? uu : 0) + (gg > 0 ? gg * cMax : 0) >= theta) { inActive[post] = 1; active[this.nActive++] = post; }
        }
      }
    }
    // 3b. Poisson drive (driven neurons are always hot)
    const sl = this.stimList, p_dt = this.p.dt / 1000, rnd = this.rand, kick = this.kick;
    for (let s = 0; s < sl.length; s++) {
      const i = sl[s];
      if (rnd() < stimRate[i] * p_dt) { if (!inActive[i]) this._heat(i, n); u[i] += kick; }
    }

    // 4. reset + schedule
    if (slot.idx.length < nf) slot.idx = new Int32Array(Math.max(nf, slot.idx.length * 2));
    const out = slot.idx, cnt = this.spikeCount, uR = this.p.vReset - this.p.v0;
    for (let s = 0; s < nf; s++) {
      const i = fired[s];
      u[i] = uR; g[i] = 0; ls[i] = n; cnt[i]++;
      out[s] = i;
    }
    slot.n = nf;
    this.nFired = nf;
    if (this.onSpikes && nf) this.onSpikes(out, nf, n);
    this.step_ = n + 1;
    return nf;
  }

  /** Advance by `ms` milliseconds; returns number of spikes. */
  run(ms) {
    const steps = Math.round(ms / this.p.dt);
    let total = 0;
    for (let s = 0; s < steps; s++) total += this.step();
    return total;
  }
}
