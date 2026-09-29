// Fetch with progress + native gzip decompression (no dependencies).

async function fetchRaw(url, onChunk) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!res.body || !res.body.getReader) { const u8 = new Uint8Array(await res.arrayBuffer()); onChunk(u8.length); return u8; }
  const reader = res.body.getReader(), chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.length; onChunk(value.length);
  }
  return concat(chunks, n);
}

function concat(chunks, n = chunks.reduce((s, c) => s + c.length, 0)) {
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function gunzipIfNeeded(u8) {
  // Some hosts transparently decode .gz (Content-Encoding) — only gunzip if still compressed.
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function fetchBytes(url, onProgress = () => {}) {
  let loaded = 0;
  return gunzipIfNeeded(await fetchRaw(url, (k) => onProgress((loaded += k), 0)));
}

/**
 * Fetch a gzip file stored as several parts (kept under GitHub's 25 MB browser-upload limit).
 * manifestUrl points to a JSON { bytes, parts: [{ file, bytes }] } next to the parts.
 */
export async function fetchSplit(manifestUrl, onProgress = () => {}) {
  const m = await (await fetch(manifestUrl)).json();
  let loaded = 0; const bufs = [];
  for (const p of m.parts) bufs.push(await fetchRaw(new URL(p.file, manifestUrl), (k) => onProgress((loaded += k), m.bytes)));
  return gunzipIfNeeded(concat(bufs));
}
