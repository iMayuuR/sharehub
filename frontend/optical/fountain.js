// fountain.js — Luby Transform (LT) coding for the optical channel.
//
// A screen-to-camera link has no back-channel: the sender cannot know which
// frames the camera missed, and the receiver may start filming halfway through.
// So the sender never "finishes" — it emits an endless stream of encoded
// symbols, each the XOR of a pseudo-random subset of the file's blocks, and the
// receiver peels the file out once it has collected enough distinct symbols in
// any order. Dropped frames cost time, never correctness.
//
// Seeds 0..K-1 are systematic (symbol i is literally block i), so a receiver
// that catches the very start of the stream finishes in exactly K frames.
// Everything after that is soliton-distributed and converges at ~1.1-1.2 K.

/** Deterministic PRNG — sender and receiver must derive identical subsets from a seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Robust soliton distribution as a cumulative table, indexed by degree.
 * Rebuilding this per frame would dominate encode time, so it is cached per K.
 */
export function robustSolitonCdf(K, c = 0.03, delta = 0.5) {
  const weight = new Float64Array(K + 1);
  weight[1] = 1 / K;
  for (let d = 2; d <= K; d++) weight[d] = 1 / (d * (d - 1));

  // Spike at K/R lifts the odds of the large-degree symbols that finish a decode.
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  if (R > 0) {
    const pivot = Math.min(K, Math.max(1, Math.floor(K / R)));
    for (let d = 1; d < pivot; d++) weight[d] += R / (d * K);
    weight[pivot] += (R * Math.log(R / delta)) / K;
  }

  let total = 0;
  for (let d = 1; d <= K; d++) total += weight[d];

  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += weight[d] / total;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  return cdf;
}

const cdfCache = new Map();

function cdfFor(K) {
  let cdf = cdfCache.get(K);
  if (!cdf) {
    cdf = robustSolitonCdf(K);
    if (cdfCache.size > 8) cdfCache.clear();
    cdfCache.set(K, cdf);
  }
  return cdf;
}

function pickDegree(cdf, r) {
  let lo = 1;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r <= cdf[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The block indices a symbol covers. Pure function of (seed, K) — this is the
 * only thing the receiver needs to invert an encoded symbol.
 * @returns {number[]}
 */
export function symbolIndices(seed, K) {
  if (seed < K) return [seed];

  const rng = mulberry32(Math.imul(seed + 1, 0x9e3779b1));
  const degree = Math.min(K, pickDegree(cdfFor(K), rng()));

  const ids = new Set();
  while (ids.size < degree) {
    ids.add(Math.min(K - 1, Math.floor(rng() * K)));
  }
  return [...ids];
}

function xorInto(target, source) {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

export class LTEncoder {
  /**
   * @param {Uint8Array} payload
   * @param {number} blockSize
   */
  constructor(payload, blockSize) {
    this.blockSize = blockSize;
    this.totalLen = payload.length;
    this.K = Math.max(1, Math.ceil(payload.length / blockSize));
    this.blocks = new Array(this.K);
    for (let i = 0; i < this.K; i++) {
      // The tail block is zero-padded; the receiver trims back to totalLen.
      const block = new Uint8Array(blockSize);
      block.set(payload.subarray(i * blockSize, Math.min(payload.length, (i + 1) * blockSize)));
      this.blocks[i] = block;
    }
  }

  /** @returns {Uint8Array} the encoded symbol for `seed` */
  symbol(seed) {
    const ids = symbolIndices(seed, this.K);
    const out = new Uint8Array(this.blockSize);
    out.set(this.blocks[ids[0]]);
    for (let i = 1; i < ids.length; i++) xorInto(out, this.blocks[ids[i]]);
    return out;
  }
}

export class LTDecoder {
  /**
   * @param {number} totalLen bytes in the original payload
   * @param {number} blockSize must match the encoder
   */
  constructor(totalLen, blockSize) {
    this.totalLen = totalLen;
    this.blockSize = blockSize;
    this.K = Math.max(1, Math.ceil(totalLen / blockSize));
    this.blocks = new Array(this.K).fill(null);
    this.decodedCount = 0;
    this.symbolsSeen = 0;
    this.seenSeeds = new Set();
    // blockIndex -> symbols still covering it, so peeling never rescans the pool
    this.pending = new Map();
  }

  get done() {
    return this.decodedCount >= this.K;
  }

  /** 0..1 */
  get progress() {
    return this.decodedCount / this.K;
  }

  /**
   * Absorb one encoded symbol.
   * @param {number} seed
   * @param {Uint8Array} data length must equal blockSize
   * @returns {boolean} true if this symbol was new (duplicates are cheap no-ops)
   */
  add(seed, data) {
    if (this.done || this.seenSeeds.has(seed)) return false;
    this.seenSeeds.add(seed);
    this.symbolsSeen++;

    const ids = new Set(symbolIndices(seed, this.K));
    const payload = data.length === this.blockSize ? data.slice() : padded(data, this.blockSize);

    // Strip out everything already known before parking the symbol.
    for (const id of ids) {
      const known = this.blocks[id];
      if (known) {
        xorInto(payload, known);
        ids.delete(id);
      }
    }

    this._absorb({ ids, data: payload, dead: false });
    return true;
  }

  _absorb(symbol) {
    if (symbol.ids.size !== 1) {
      if (symbol.ids.size === 0) return; // fully redundant
      for (const id of symbol.ids) this._index(id).add(symbol);
      return;
    }

    const queue = [];
    const first = symbol.ids.values().next().value;
    this._resolve(first, symbol.data, queue);

    while (queue.length) {
      const id = queue.pop();
      const waiting = this.pending.get(id);
      if (!waiting) continue;
      this.pending.delete(id);

      for (const other of waiting) {
        if (other.dead) continue;
        xorInto(other.data, this.blocks[id]);
        other.ids.delete(id);
        if (other.ids.size > 1) continue;

        other.dead = true;
        if (other.ids.size === 0) continue;
        const target = other.ids.values().next().value;
        this.pending.get(target)?.delete(other);
        this._resolve(target, other.data, queue);
      }
    }
  }

  _resolve(id, data, queue) {
    if (this.blocks[id]) return;
    this.blocks[id] = data;
    this.decodedCount++;
    queue.push(id);
  }

  _index(id) {
    let set = this.pending.get(id);
    if (!set) {
      set = new Set();
      this.pending.set(id, set);
    }
    return set;
  }

  /**
   * @returns {Uint8Array|null} the reassembled payload, or null while incomplete
   */
  result() {
    if (!this.done) return null;
    const out = new Uint8Array(this.totalLen);
    for (let i = 0; i < this.K; i++) {
      const offset = i * this.blockSize;
      const take = Math.min(this.blockSize, this.totalLen - offset);
      if (take <= 0) break;
      out.set(this.blocks[i].subarray(0, take), offset);
    }
    return out;
  }
}

function padded(data, size) {
  const out = new Uint8Array(size);
  out.set(data.subarray(0, size));
  return out;
}
