// bundle.js — several files as one fountain-coded payload.
//
// The optical channel carries exactly one byte stream, so multi-file beaming
// concatenates the files behind a manifest and sends that. The manifest lives
// inside the payload rather than in the meta frame: a meta frame has to fit in
// a single QR code, and a list of forty filenames does not.
//
//   0..3    magic 'SHB1'
//   4..7    manifest length, u32 little-endian
//   8..     manifest JSON — [{ n: name, m: mime, s: size }, ...]
//   then    every file's bytes, back to back, in manifest order

const MAGIC = [0x53, 0x48, 0x42, 0x31]; // SHB1
const HEADER = 8;

/**
 * @param {Array<{name: string, type: string, bytes: Uint8Array}>} files
 * @returns {Uint8Array}
 */
export function packBundle(files) {
  const manifest = new TextEncoder().encode(
    JSON.stringify(files.map((file) => ({ n: file.name, m: file.type || '', s: file.bytes.length })))
  );

  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const out = new Uint8Array(HEADER + manifest.length + total);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, manifest.length, true);
  out.set(manifest, HEADER);

  let offset = HEADER + manifest.length;
  for (const file of files) {
    out.set(file.bytes, offset);
    offset += file.bytes.length;
  }
  return out;
}

export function isBundle(bytes) {
  return bytes.length >= HEADER && MAGIC.every((byte, i) => bytes[i] === byte);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Array<{name: string, type: string, bytes: Uint8Array}>|null} null if this is not a bundle
 */
export function unpackBundle(bytes) {
  if (!isBundle(bytes)) return null;

  const manifestLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (HEADER + manifestLength > bytes.length) return null;

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER, HEADER + manifestLength)));
  } catch {
    return null;
  }
  if (!Array.isArray(manifest)) return null;

  const files = [];
  let offset = HEADER + manifestLength;
  for (const entry of manifest) {
    const size = Number(entry.s) || 0;
    if (offset + size > bytes.length) return null;
    files.push({
      name: entry.n || 'file',
      type: entry.m || 'application/octet-stream',
      bytes: bytes.subarray(offset, offset + size),
    });
    offset += size;
  }
  return files;
}
