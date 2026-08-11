// Deterministic test payloads, written to disk for the file picker to pick up.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.artifacts');

/** Incompressible, so gzip is skipped and sizes stay predictable. */
export function noise(size, seed = 1) {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

/**
 * @returns {{name: string, path: string, bytes: Uint8Array, size: number}}
 */
export function fixtureFile(name, size, seed = 1) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const bytes = noise(size, seed);
  const filePath = path.join(ARTIFACTS, name);
  writeFileSync(filePath, Buffer.from(bytes));
  return { name, path: filePath, bytes, size };
}
