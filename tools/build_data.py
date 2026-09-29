#!/usr/bin/env python3
"""Pack the FlyWire connectome + annotations into compact browser-friendly binaries.

Inputs (not redistributed here, fetched by tools/fetch_sources.sh):
  - Shiu et al. 2024 model data: Completeness_783.csv, Connectivity_783.parquet
  - FlyWire annotations (Schlegel et al. 2024): Supplemental_file1_neuron_annotations.tsv

Outputs (data/):
  - connectome.json + connectome.bin.gz.partNN : CSR graph (by presynaptic neuron), varint + delta
    encoded, gzipped, split into <25 MB parts (concatenate the parts, then gunzip)
  - neurons.bin.gz    : per-neuron positions / class / type / side / NT / FlyWire ID
  - neurons.json      : string tables

connectome.bin layout (little endian):
  magic "F67C" | u32 version=1 | u32 N | u32 E | u32 lenBytes | u32 colBytes | u32 wBytes
  lens  : N varints  (out-degree of each neuron)
  cols  : E varints  (post index, delta-coded inside each row; rows sorted ascending)
  ws    : E varints  (zigzag signed synapse count; sign = predicted NT excitatory/inhibitory)
"""
import argparse, gzip, json, struct
from pathlib import Path

import numpy as np
import pandas as pd


def varint(values: np.ndarray) -> bytes:
    """Vectorised unsigned LEB128 encoding."""
    v = values.astype(np.uint64)
    nbytes = np.ones(len(v), dtype=np.int64)
    t = v >> np.uint64(7)
    while True:
        m = t > 0
        if not m.any():
            break
        nbytes += m
        t = t >> np.uint64(7)
    total = int(nbytes.sum())
    out = np.empty(total, dtype=np.uint8)
    starts = np.concatenate(([0], np.cumsum(nbytes)[:-1]))
    cur = v.copy()
    for k in range(int(nbytes.max())):
        m = nbytes > k
        byte = (cur[m] & np.uint64(0x7F)).astype(np.uint8)
        cont = (nbytes[m] > k + 1).astype(np.uint8) << 7
        out[starts[m] + k] = byte | cont
        cur[m] = cur[m] >> np.uint64(7)
    return out.tobytes()


def zigzag(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.int64)
    return ((x << 1) ^ (x >> 63)).astype(np.uint64)


def build(comp, con, ann, out: Path, tag: str):
    out.mkdir(parents=True, exist_ok=True)
    df_comp = pd.read_csv(comp, index_col=0)
    ids = df_comp.index.values.astype(np.int64)
    N = len(ids)

    df = pd.read_parquet(con, columns=['Presynaptic_Index', 'Postsynaptic_Index', 'Excitatory x Connectivity'])
    pre = df['Presynaptic_Index'].values.astype(np.int64)
    post = df['Postsynaptic_Index'].values.astype(np.int64)
    w = df['Excitatory x Connectivity'].values.astype(np.int64)
    del df
    order = np.lexsort((post, pre))
    pre, post, w = pre[order], post[order], w[order]
    E = len(pre)
    lens = np.bincount(pre, minlength=N)
    row_start = np.concatenate(([0], np.cumsum(lens)[:-1]))
    first = np.zeros(E, dtype=bool)
    first[row_start[lens > 0]] = True
    delta = post.copy()
    delta[~first] = post[~first] - post[np.nonzero(~first)[0] - 1]
    assert (delta >= 0).all()

    b_len, b_col, b_w = varint(lens), varint(delta), varint(zigzag(w))
    header = b'F67C' + struct.pack('<6I', 1, N, E, len(b_len), len(b_col), len(b_w))
    raw = header + b_len + b_col + b_w
    gz = gzip.compress(raw, compresslevel=9)
    if tag:                                   # validation graph: single file (not in the repo)
        (out / f'connectome{tag}.bin.gz').write_bytes(gz)
    else:                                     # web: parts < 25 MB (GitHub browser-upload limit) + manifest
        CH = 15 * 1024 * 1024
        parts = []
        for i in range(0, len(gz), CH):
            name = f'connectome.bin.gz.part{i // CH:02d}'
            (out / name).write_bytes(gz[i:i + CH])
            parts.append({'file': name, 'bytes': len(gz[i:i + CH])})
        (out / 'connectome.json').write_text(json.dumps(
            {'format': 'gzip split into parts; concatenate in order, then gunzip', 'bytes': len(gz), 'parts': parts}, indent=2) + '\n')
    print(f'[{tag or "783"}] N={N} E={E} raw={len(raw)/1e6:.1f}MB gz={len(gz)/1e6:.1f}MB')

    if ann is None:
        np.save(out / f'ids{tag}.npy', ids)
        return

    a = pd.read_csv(ann, sep='\t', low_memory=False).drop_duplicates('root_id').set_index('root_id')
    a = a.reindex(ids)

    def table(col, fill=''):
        s = a[col].fillna(fill).astype(str)
        cats = sorted(set(s))
        if fill in cats:
            cats.remove(fill)
        cats = [fill] + cats
        lut = {c: i for i, c in enumerate(cats)}
        return cats, s.map(lut).values

    superclasses, sc_idx = table('super_class', 'unknown')
    cell_classes, cc_idx = table('cell_class')
    cell_types, ct_idx = table('cell_type')
    nts, nt_idx = table('top_nt')
    side_map = {'left': 1, 'right': 2, 'center': 3}
    side = a['side'].map(side_map).fillna(0).astype(np.uint8).values

    # FlyWire coords are voxel units (4 x 4 x 40 nm). Store in 0.1 µm steps, centred.
    xyz = a[['pos_x', 'pos_y', 'pos_z']].values.astype(np.float64)
    xyz *= np.array([4, 4, 40]) / 1000.0
    ok = ~np.isnan(xyz).any(1)
    centre = np.nanmedian(xyz[ok], 0)
    xyz[~ok] = centre
    q = np.round((xyz - centre) * 10).astype(np.int16)

    # degree stats for the inspector
    indeg = np.bincount(post, minlength=N)

    buf = bytearray(b'F67N' + struct.pack('<2I', 1, N))
    buf += ids.astype('<u8').tobytes()
    buf += q.astype('<i2').tobytes()
    buf += sc_idx.astype('<u1').tobytes()
    buf += side.astype('<u1').tobytes()
    buf += nt_idx.astype('<u1').tobytes()
    buf += cc_idx.astype('<u2').tobytes()
    buf += ct_idx.astype('<u2').tobytes()
    buf += np.minimum(lens, 65535).astype('<u2').tobytes()
    buf += np.minimum(indeg, 65535).astype('<u2').tobytes()
    with gzip.open(out / 'neurons.bin.gz', 'wb', compresslevel=9) as f:
        f.write(bytes(buf))
    meta = {
        'version': 783, 'N': int(N), 'E': int(E),
        'superClasses': superclasses, 'cellClasses': cell_classes,
        'cellTypes': cell_types, 'nts': nts,
        'units': 'positions in 0.1 µm, centred on brain median',
    }
    (out / 'neurons.json').write_text(json.dumps(meta, separators=(',', ':')))
    print(f'neurons.bin.gz={(out / "neurons.bin.gz").stat().st_size/1e6:.2f}MB types={len(cell_types)}')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--src', default='sources/Drosophila_brain_model')
    p.add_argument('--ann', default='sources/flywire_annotations/supplemental_files/Supplemental_file1_neuron_annotations.tsv')
    p.add_argument('--out', default='data')
    p.add_argument('--v630', action='store_true', help='also build the v630 graph used for validation')
    args = p.parse_args()
    src = Path(args.src)
    build(src / 'Completeness_783.csv', src / 'Connectivity_783.parquet', args.ann, Path(args.out), '')
    if args.v630:
        build(src / '2023_03_23_completeness_630_final.csv', src / '2023_03_23_connectivity_630_final.parquet',
              None, Path('validation/data'), '_630')
