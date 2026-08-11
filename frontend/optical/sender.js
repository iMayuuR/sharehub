// sender.js — drives the animated QR stream ("Beam").
//
// The sender never stops and never waits for anyone: it loops fountain-coded
// frames forever, so a receiver can join at any moment and still finish. Meta
// frames are sprinkled in so the receiver can name the file long before it has
// enough symbols to rebuild it.

import { LTEncoder } from './fountain.js';
import {
  packDataFrame,
  packMetaFrame,
  frameToText,
  sha256Hex,
  maybeCompress,
  FLAG_GZIP,
  FLAG_BUNDLE,
  HEADER_SIZE,
  DATA_HEADER_SIZE,
} from './protocol.js';
import { packBundle } from './bundle.js';
import { makeQr, drawQr, densityById, DEFAULT_DENSITY } from './qr-render.js';
import { createWakeLock } from './wake-lock.js';

/** Sparsest meta cadence — one frame in sixteen, ~6% of airtime for instant UX. */
const META_EVERY = 16;

/**
 * A small file can finish inside the systematic prefix, before a 1-in-16 meta
 * frame ever comes round, and would then land as `optical-1234.bin` with no
 * checksum. Aim for roughly three meta frames per pass so the name and hash
 * always beat the last block home.
 */
function metaCadence(blocks) {
  return Math.max(2, Math.min(META_EVERY, Math.floor(blocks / 3)));
}

/** Bytes that `,"p":""` itself costs in the meta JSON. */
const PAD_FIELD_OVERHEAD = 7;

/** Optical is a slow channel; beyond this a transfer stops being reasonable. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export class OpticalSender {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.density = densityById(DEFAULT_DENSITY);
    this.fps = 12;
    this.targetCss = 320;

    this.onStats = null;
    this.running = false;

    this.payload = null;
    this.meta = null;
    this.flags = 0;
    this.encoder = null;
    this.sessionId = 0;

    this.seed = 0;
    this.frameCount = 0;
    this.startedAt = 0;
    this.lastFrameAt = 0;
    this.lastStatsAt = 0;
    this.raf = null;
    this.wakeLock = createWakeLock();

    this._tick = this._tick.bind(this);
  }

  /**
   * @param {File|Blob|Array<File|Blob>} input one file, or several to bundle
   * @returns {Promise<{name:string, size:number, count:number, gzipped:boolean, packedSize:number}>}
   */
  async load(input) {
    const files = Array.isArray(input) ? input.filter(Boolean) : [input];
    if (!files.length) throw new Error('Nothing to send');

    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_FILE_BYTES) {
      throw new Error(
        `${files.length > 1 ? 'These files are' : 'File is'} too large for Lightwave (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`
      );
    }
    if (total === 0) throw new Error(files.length > 1 ? 'Those files are empty' : 'File is empty');

    let raw;
    let bundled = false;
    if (files.length === 1) {
      raw = new Uint8Array(await files[0].arrayBuffer());
    } else {
      // One byte stream goes down the wire, so several files travel as a bundle.
      const loaded = await Promise.all(
        files.map(async (file) => ({
          name: file.name || 'shared_file',
          type: file.type || 'application/octet-stream',
          bytes: new Uint8Array(await file.arrayBuffer()),
        }))
      );
      raw = packBundle(loaded);
      bundled = true;
    }

    const hash = await sha256Hex(raw);
    const { bytes, gzipped } = await maybeCompress(raw);

    this.payload = bytes;
    this.flags = (gzipped ? FLAG_GZIP : 0) | (bundled ? FLAG_BUNDLE : 0);
    this.file = {
      name: bundled ? `${files.length} files` : files[0].name || 'shared_file',
      type: bundled ? 'application/x-sharehub-bundle' : files[0].type || 'application/octet-stream',
      size: total,
      count: files.length,
    };
    this.meta = { n: this.file.name, m: this.file.type, s: total, h: hash };
    if (bundled) this.meta.c = files.length;
    this._rebuild();

    return { name: this.file.name, size: total, count: files.length, gzipped, packedSize: bytes.length };
  }

  setDensity(id) {
    this.density = densityById(id);
    this._rebuild();
  }

  setFps(fps) {
    this.fps = Math.max(2, Math.min(30, fps));
  }

  /** Pixel budget for the code on screen; the renderer rounds down to whole modules. */
  setTargetSize(px) {
    this.targetCss = Math.max(120, Math.floor(px));
  }

  get blockCount() {
    return this.encoder ? this.encoder.K : 0;
  }

  /** Seconds for one full pass over the file at the current settings. */
  get passSeconds() {
    if (!this.encoder) return 0;
    const cadence = metaCadence(this.encoder.K);
    const dataFramesPerSecond = this.fps * ((cadence - 1) / cadence);
    return this.encoder.K / dataFramesPerSecond;
  }

  start() {
    if (this.running || !this.encoder) return;
    this.running = true;
    this.startedAt = performance.now();
    this.lastFrameAt = 0;
    this.frameCount = 0;
    this.seed = 0;
    this.wakeLock.start();
    this.raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.wakeLock.stop();
  }

  _rebuild() {
    if (!this.payload) return;

    // A new session id every rebuild. Changing density mid-beam re-cuts the file
    // into different blocks, and a receiver that kept peeling the old ones would
    // never finish — the id change is what tells it to start over.
    this.sessionId = (Math.random() * 0x10000) | 0;

    const blockSize = this.density.bytes - DATA_HEADER_SIZE;
    this.encoder = new LTEncoder(this.payload, blockSize);
    this.metaText = frameToText(this._metaFrame(blockSize));
    this.seed = 0;
  }

  /**
   * Meta frames carry far less than a data frame, which would put them in a
   * smaller QR version — and a code that changes size every few frames makes
   * the receiver re-aim mid-transfer. Pad it out to the same length so every
   * frame in the stream draws at exactly the same size.
   */
  _metaFrame(blockSize) {
    const build = (meta) =>
      packMetaFrame({
        sessionId: this.sessionId,
        flags: this.flags,
        totalLen: this.payload.length,
        blockSize,
        meta,
      });

    const meta = this._fitMeta();
    const bytes = build(meta);
    const slack = this.density.bytes - bytes.length - PAD_FIELD_OVERHEAD;
    return slack > 0 ? build({ ...meta, p: 'A'.repeat(slack) }) : bytes;
  }

  /** Keep the meta frame inside one QR by shortening an over-long filename. */
  _fitMeta() {
    const budget = this.density.bytes - HEADER_SIZE;
    const encoder = new TextEncoder();
    const meta = { ...this.meta };
    const dot = meta.n.lastIndexOf('.');
    const ext = dot > 0 ? meta.n.slice(dot, dot + 8) : '';
    let stem = dot > 0 ? meta.n.slice(0, dot) : meta.n;

    while (encoder.encode(JSON.stringify(meta)).length > budget && stem.length > 1) {
      stem = stem.slice(0, Math.max(1, stem.length - 8));
      meta.n = `${stem}…${ext}`;
    }
    return meta;
  }

  _tick(now) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this._tick);

    const interval = 1000 / this.fps;
    // Half-frame slack: at 60 Hz a 15 fps target must not skip to 12 fps.
    if (now - this.lastFrameAt < interval - 8) return;
    this.lastFrameAt = now;

    this._drawFrame();

    if (this.onStats && now - this.lastStatsAt > 250) {
      this.lastStatsAt = now;
      const elapsed = (now - this.startedAt) / 1000;
      this.onStats({
        frames: this.frameCount,
        seeds: this.seed,
        blocks: this.encoder.K,
        passProgress: Math.min(1, this.seed / this.encoder.K),
        passSeconds: this.passSeconds,
        elapsed,
        actualFps: elapsed > 0 ? this.frameCount / elapsed : 0,
        moduleCount: this.moduleCount || 0,
      });
    }
  }

  _drawFrame() {
    let text = this.metaText;
    if (this.frameCount % metaCadence(this.encoder.K) !== 0) {
      const seed = this.seed++;
      text = frameToText(
        packDataFrame({
          sessionId: this.sessionId,
          flags: this.flags,
          totalLen: this.payload.length,
          blockSize: this.encoder.blockSize,
          seed,
          symbol: this.encoder.symbol(seed),
        })
      );
    }

    const { moduleCount } = drawQr(this.canvas, makeQr(text, this.density.ecc), { targetCss: this.targetCss });
    this.moduleCount = moduleCount;
    this.frameCount++;
  }
}
