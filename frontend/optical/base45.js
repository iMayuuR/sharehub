// base45.js — RFC 9285 Base45.
//
// The 45-character Base45 alphabet is exactly the QR alphanumeric charset, so an
// encoded frame rides in alphanumeric mode (2 bytes per 3 characters, ~97% of the
// capacity of raw byte mode) instead of byte mode. The payoff is that every QR
// reader hands the frame back byte-exact — including the native BarcodeDetector,
// which only ever returns a string and would mangle arbitrary bytes.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

/**
 * @param {Uint8Array} bytes
 * @returns {string} Base45 text, safe for QR alphanumeric mode
 */
export function encodeBase45(bytes) {
  const out = new Array(base45Length(bytes.length));
  let p = 0;
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    const n = bytes[i] * 256 + bytes[i + 1];
    out[p++] = ALPHABET[n % 45];
    out[p++] = ALPHABET[((n / 45) | 0) % 45];
    out[p++] = ALPHABET[(n / 2025) | 0];
  }
  if (i < bytes.length) {
    const n = bytes[i];
    out[p++] = ALPHABET[n % 45];
    out[p++] = ALPHABET[(n / 45) | 0];
  }
  return out.join('');
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 * @throws {Error} on any character or group that is not valid Base45
 */
export function decodeBase45(text) {
  const len = text.length;
  const rem = len % 3;
  if (rem === 1) throw new Error('base45: truncated group');

  const out = new Uint8Array(((len / 3) | 0) * 2 + (rem === 2 ? 1 : 0));
  let p = 0;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = value(text, i) + value(text, i + 1) * 45 + value(text, i + 2) * 2025;
    if (n > 0xffff) throw new Error('base45: group overflow');
    out[p++] = n >> 8;
    out[p++] = n & 0xff;
  }
  if (rem === 2) {
    const n = value(text, i) + value(text, i + 1) * 45;
    if (n > 0xff) throw new Error('base45: group overflow');
    out[p++] = n;
  }
  return out;
}

function value(text, i) {
  const code = text.charCodeAt(i);
  const v = code < 128 ? VALUES[code] : -1;
  if (v < 0) throw new Error(`base45: bad character at ${i}`);
  return v;
}

/** Characters needed to encode `byteLength` bytes. */
export function base45Length(byteLength) {
  return byteLength % 2 === 0 ? (byteLength / 2) * 3 : ((byteLength - 1) / 2) * 3 + 2;
}

/** Largest byte count that still fits in `chars` Base45 characters. */
export function maxBytesForChars(chars) {
  const whole = ((chars / 3) | 0) * 2;
  return chars % 3 === 2 ? whole + 1 : whole;
}
