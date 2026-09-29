# data

Derived from FlyWire v783 (CC-BY 4.0). Regenerate with `python3 tools/build_data.py`.

| file | content |
|---|---|
| `connectome.json` + `connectome.bin.gz.part00`, `.part01` | one gzip file split in two (< 25 MB each, so it can be uploaded through the GitHub website); concatenate the parts in order, then gunzip. Inside: CSR graph, 138,639 neurons × 15,091,983 connections. Header `F67C`, then out-degrees, delta-coded post indices, zig-zag signed synapse counts — all LEB128 varints. |
| `neurons.bin.gz` | Header `F67N`, then per neuron: FlyWire root ID (u64), position (3×i16, 0.1 µm, centred), super class (u8), side (u8), transmitter (u8), cell class (u16), cell type (u16), out/in degree (u16). |
| `neurons.json` | String tables for the categorical columns. |
