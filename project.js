// Project file: a plain ZIP archive holding the photos, their previews and a project.json with
// dates, captions and selections. Written with method 0 (store) because JPEGs do not compress,
// and assembled as a Blob of Blob parts so a large project is never held in memory at once.

export const PROJECT_FORMAT = 'family-photo-evidence-project';
const ZIP_LIMIT = 0xFFFFFFFF; // no ZIP64: offsets and sizes must fit in 32 bits

// ---------- CRC-32 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export async function crc32(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- ZIP writer (store only) ----------

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * entries: [{name, blob, crc?}]  crc is computed when missing.
 * Returns a Blob in ZIP format.
 */
export async function writeZip(entries, onProgress = () => {}) {
  if (entries.length >= 0xFFFF) throw new Error('Too many files for one project file');
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [], central = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    onProgress(i, entries.length);
    const name = enc.encode(e.name);
    const crc = e.crc ?? await crc32(e.blob);
    const size = e.blob.size;
    if (offset + 30 + name.length + size > ZIP_LIMIT) throw new Error('Project is larger than 4 GB. Save only the selected photos.');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true); // store
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  if (offset + cdSize + 22 > ZIP_LIMIT) throw new Error('Project is larger than 4 GB. Save only the selected photos.');
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd.buffer], { type: 'application/zip' });
}

// ---------- ZIP reader ----------

/** Returns Map name -> {get: () => Promise<Blob>} reading lazily from the file. */
export async function readZip(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a project file (no ZIP directory found)');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) throw new Error('ZIP64 project files are not supported');
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged project file');
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, {
      async get() {
        const lh = new DataView(await file.slice(local, local + 30).arrayBuffer());
        const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + csize);
        if (method === 0) return raw;
        if (method === 8 && self.DecompressionStream) {
          return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        }
        throw new Error(`Unsupported compression in ${name}`);
      },
    });
  }
  return out;
}
