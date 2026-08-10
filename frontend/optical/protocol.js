// protocol.js — wire format for optical (screen → camera) transfer.
//
// Every frame is self-describing: there is no handshake and no back-channel, so
// a receiver that starts filming at an arbitrary moment must be able to make
// sense of the very first frame it catches.
//
//   Common header (12 bytes, little-endian)
//     0      magic 0x53 'S'
//     1      version << 4 | type      type 0 = meta, 1 = data
//     2      flags                    bit 0: payload is gzipped
//     3      reserved (0)
//     4..5   sessionId  u16           changes when the sender picks a new file
//     6..9   totalLen   u32           bytes in the fountain payload
//     10..11 blockSize  u16
//
//   Data frame adds
//     12..15 seed       u32           selects the block subset (see fountain.js)
//     16..   symbol     blockSize bytes
//
//   Meta frame adds
//     12..   UTF-8 JSON { n: name, m: mime, s: originalSize, h: sha256 hex }
//
// Meta frames are pure UX — they let the receiver show "photo.jpg, 2.3 MB"
// seconds before the file finishes. Correctness depends only on data frames.

import { encodeBase45, decodeBase45 } from './base45.js';

export const MAGIC = 0x53;
export const PROTOCOL_VERSION = 1;
export const FRAME_META = 0;
export const FRAME_DATA = 1;
export const FLAG_GZIP = 0x01;
/** Payload is a multi-file bundle rather than a single file — see bundle.js. */
export const FLAG_BUNDLE = 0x02;

export const HEADER_SIZE = 12;
export const DATA_HEADER_SIZE = 16;

function writeHeader(view, type, { flags, sessionId, totalLen, blockSize }) {
  view.setUint8(0, MAGIC);
  view.setUint8(1, (PROTOCOL_VERSION << 4) | (type & 0x0f));
  view.setUint8(2, flags & 0xff);
  view.setUint8(3, 0);
  view.setUint16(4, sessionId, true);
  view.setUint32(6, totalLen, true);
  view.setUint16(10, blockSize, true);
}

/**
 * @param {{sessionId:number, flags:number, totalLen:number, blockSize:number, seed:number, symbol:Uint8Array}} frame
 * @returns {Uint8Array}
 */
export function packDataFrame(frame) {
  const bytes = new Uint8Array(DATA_HEADER_SIZE + frame.symbol.length);
  const view = new DataView(bytes.buffer);
  writeHeader(view, FRAME_DATA, frame);
  view.setUint32(12, frame.seed, true);
  bytes.set(frame.symbol, DATA_HEADER_SIZE);
  return bytes;
}

/**
 * @param {{sessionId:number, flags:number, totalLen:number, blockSize:number, meta:object}} frame
 * @returns {Uint8Array}
 */
export function packMetaFrame(frame) {
  const json = new TextEncoder().encode(JSON.stringify(frame.meta));
  const bytes = new Uint8Array(HEADER_SIZE + json.length);
  writeHeader(new DataView(bytes.buffer), FRAME_META, frame);
  bytes.set(json, HEADER_SIZE);
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{type:number, flags:number, sessionId:number, totalLen:number, blockSize:number, seed?:number, symbol?:Uint8Array, meta?:object}|null}
 *   null when the bytes are not a frame we understand — a mis-decoded QR, a
 *   sticker on a wall, or a future protocol version.
 */
export function parseFrame(bytes) {
  if (!bytes || bytes.length < HEADER_SIZE || bytes[0] !== MAGIC) return null;
  if (bytes[1] >> 4 !== PROTOCOL_VERSION) return null;

  const type = bytes[1] & 0x0f;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    type,
    flags: bytes[2],
    sessionId: view.getUint16(4, true),
    totalLen: view.getUint32(6, true),
    blockSize: view.getUint16(10, true),
  };
  if (header.blockSize === 0 || header.totalLen === 0) return null;

  if (type === FRAME_DATA) {
    if (bytes.length < DATA_HEADER_SIZE + header.blockSize) return null;
    header.seed = view.getUint32(12, true);
    header.symbol = bytes.subarray(DATA_HEADER_SIZE, DATA_HEADER_SIZE + header.blockSize);
    return header;
  }

  if (type === FRAME_META) {
    try {
      header.meta = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_SIZE)));
    } catch {
      return null;
    }
    return header;
  }

  return null;
}

/** Frame bytes → the string that goes into the QR code. */
export function frameToText(bytes) {
  return encodeBase45(bytes);
}

/** Decoded QR string → frame, or null if it is not one of ours. */
export function textToFrame(text) {
  if (!text) return null;
  try {
    return parseFrame(decodeBase45(text));
  } catch {
    return null;
  }
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const gzipSupported = typeof CompressionStream !== 'undefined';

export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Compressing a JPEG or an MP4 just wastes CPU and grows the payload, so try it
 * and keep the result only when it is a real win.
 */
export async function maybeCompress(bytes) {
  if (!gzipSupported || bytes.length < 4096) return { bytes, gzipped: false };
  try {
    const packed = await gzip(bytes);
    if (packed.length < bytes.length * 0.92) return { bytes: packed, gzipped: true };
  } catch {
    /* fall through to raw */
  }
  return { bytes, gzipped: false };
}
