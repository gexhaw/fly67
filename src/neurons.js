// Neuron metadata (positions, classes, types, FlyWire IDs) + helpers to resolve neuron sets.

export function decodeNeurons(buffer, meta) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'F67N') throw new Error('not a FLY67 neurons file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const N = dv.getUint32(8, true);
  let p = 12;
  const take = (Ctor, count) => {
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    const out = new Ctor(count);
    new Uint8Array(out.buffer).set(u8.subarray(p, p + bytes));
    p += bytes;
    return out;
  };
  const idsRaw = take(BigUint64Array, N);
  const pos = take(Int16Array, 3 * N);
  const superClass = take(Uint8Array, N);
  const side = take(Uint8Array, N);
  const nt = take(Uint8Array, N);
  const cellClass = take(Uint16Array, N);
  const cellType = take(Uint16Array, N);
  const outDeg = take(Uint16Array, N);
  const inDeg = take(Uint16Array, N);
  const ids = new Array(N);
  for (let i = 0; i < N; i++) ids[i] = idsRaw[i].toString();
  return new NeuronTable({ N, ids, pos, superClass, side, nt, cellClass, cellType, outDeg, inDeg }, meta);
}

const SIDES = ['', 'left', 'right', 'center'];

export class NeuronTable {
  constructor(cols, meta) {
    Object.assign(this, cols);
    this.meta = meta;
    this.idToIndex = new Map(this.ids.map((id, i) => [id, i]));
    this.byType = new Map();
    for (let i = 0; i < this.N; i++) {
      const t = meta.cellTypes[this.cellType[i]];
      if (!t) continue;
      if (!this.byType.has(t)) this.byType.set(t, []);
      this.byType.get(t).push(i);
    }
  }
  typeOf(i) { return this.meta.cellTypes[this.cellType[i]] || ''; }
  classOf(i) { return this.meta.cellClasses[this.cellClass[i]] || ''; }
  superClassOf(i) { return this.meta.superClasses[this.superClass[i]] || ''; }
  sideOf(i) { return SIDES[this.side[i]]; }
  ntOf(i) { return this.meta.nts[this.nt[i]] || ''; }
  label(i) { return this.typeOf(i) || this.classOf(i) || this.superClassOf(i) || 'neuron'; }

  /**
   * Resolve a selector into neuron indices.
   *  { ids: [...] }                    explicit FlyWire root IDs (missing ones are skipped)
   *  { types: [...], side?: 'left' }   exact cell types
   *  { typePrefix: 'JO-C', side? }     cell types starting with prefix
   */
  select(sel) {
    let out = [];
    if (sel.ids) for (const id of sel.ids) { const i = this.idToIndex.get(String(id)); if (i !== undefined) out.push(i); }
    if (sel.types) for (const t of sel.types) out.push(...(this.byType.get(t) || []));
    if (sel.typePrefix) {
      const pre = [].concat(sel.typePrefix);
      for (const [t, list] of this.byType) if (pre.some((p) => t.startsWith(p))) out.push(...list);
    }
    if (sel.side) out = out.filter((i) => SIDES[this.side[i]] === sel.side);
    return [...new Set(out)];
  }

  search(query, limit = 30) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    if (/^\d{6,}$/.test(q)) {
      const i = this.idToIndex.get(q);
      return i === undefined ? [] : [{ kind: 'neuron', label: `${this.label(i)} · ${this.sideOf(i)}`, indices: [i] }];
    }
    const res = [];
    for (const [t, list] of this.byType) {
      const tl = t.toLowerCase();
      if (tl.includes(q)) res.push({ kind: 'type', label: t, indices: list, score: tl === q ? 0 : tl.startsWith(q) ? 1 : 2 });
    }
    res.sort((a, b) => a.score - b.score || a.label.length - b.label.length);
    return res.slice(0, limit);
  }
}
