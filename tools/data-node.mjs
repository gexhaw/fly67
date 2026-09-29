// Node helpers: load the packed data files from data/ (connectome is stored in parts).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeConnectome } from '../src/engine.js';
import { decodeNeurons } from '../src/neurons.js';

const DATA = new URL('../data/', import.meta.url);

export function loadConnectome() {
  const m = JSON.parse(readFileSync(new URL('connectome.json', DATA), 'utf8'));
  const raw = Buffer.concat(m.parts.map((p) => readFileSync(new URL(p.file, DATA))));
  return decodeConnectome(gunzipSync(raw));
}

export function loadNeurons() {
  const meta = JSON.parse(readFileSync(new URL('neurons.json', DATA), 'utf8'));
  return decodeNeurons(gunzipSync(readFileSync(new URL('neurons.bin.gz', DATA))), meta);
}
