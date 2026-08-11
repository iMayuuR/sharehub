// receiver.js — camera side of PhotonHub ("Catch").
//
// Grabs the centre square of the camera feed, decodes whatever QR is in it, and
// feeds every frame it recognises to the fountain decoder. Frames arrive out of
// order and most of them are duplicates; both are fine.
//
// Two decode backends: the native BarcodeDetector when the browser has it
// (Chrome/Edge/Android — roughly an order of magnitude faster), otherwise jsQR
// in a worker. Both hand back a string, because frames travel as Base45 in QR
// alphanumeric mode precisely so that a string is lossless.

import { LTDecoder } from './fountain.js';
import { textToFrame, FRAME_DATA, FRAME_META, FLAG_GZIP, FLAG_BUNDLE, gunzip, sha256Hex } from './protocol.js';
import { unpackBundle } from './bundle.js';

// Never rescale a frame on its way to the decoder. Resampling interpolates
// across module edges, and a dense code whose modules are only a few pixels
// wide stops decoding entirely once they are blurred together — jsQR reads a
// 97-module code at native size and fails on the very same frame resized. So
// the region of interest is handed over exactly as the camera produced it, and
// the camera is asked for a resolution each decoder can keep up with instead.
const CAMERA_HINT = {
  native: { width: 1920, height: 1080 },
  jsqr: { width: 1280, height: 720 },
};

/** Only above this does a frame get scaled down, and then by a whole factor. */
const MAX_DECODE_SIZE = 1440;

export class OpticalReceiver {
  /**
   * @param {HTMLVideoElement} video
   */
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.running = false;
    this.busy = false;

    this.detector = null;
    this.worker = null;
    this.pendingDecodes = new Map();
    this.nextDecodeId = 1;

    this.decoder = null;
    this.session = null;
    this.meta = null;
    this.flags = 0;
    this.firstSymbolAt = 0;
    this.framesDecoded = 0;

    this.onStatus = null;
    this.onMeta = null;
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    this._frame = this._frame.bind(this);
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access needs a secure page (https) and a browser with getUserMedia.');
    }

    // Which decoder we get decides how much camera we can ask for.
    await this._initBackend();
    const hint = CAMERA_HINT[this.backend] || CAMERA_HINT.jsqr;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: hint.width },
        height: { ideal: hint.height },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });

    // Keep the code sharp as the user moves the phone in and out.
    const [track] = this.stream.getVideoTracks();
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {
      /* not every camera exposes focus control */
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();

    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingDecodes.clear();
  }

  /** Throw away everything decoded so far and wait for a fresh stream. */
  reset() {
    this.decoder = null;
    this.session = null;
    this.meta = null;
    this.flags = 0;
    this.firstSymbolAt = 0;
    this.framesDecoded = 0;
  }

  async _initBackend() {
    if (typeof BarcodeDetector !== 'undefined') {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          this.detector = new BarcodeDetector({ formats: ['qr_code'] });
          this.backend = 'native';
          return;
        }
      } catch {
        /* fall through to the worker */
      }
    }

    this.worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => {
      const { id, text } = event.data;
      const resolve = this.pendingDecodes.get(id);
      if (resolve) {
        this.pendingDecodes.delete(id);
        resolve(text);
      }
    };
    this.useBitmap = typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
    this.backend = 'jsqr';
  }

  _schedule() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) {
      this.video.requestVideoFrameCallback(this._frame);
    } else {
      requestAnimationFrame(this._frame);
    }
  }

  async _frame() {
    if (!this.running) return;
    if (this.busy) {
      this._schedule();
      return;
    }
    this.busy = true;

    try {
      const text = await this._decodeCurrentFrame();
      if (text) this._ingest(text);
    } catch (err) {
      if (this.onError) this.onError(err);
    } finally {
      this.busy = false;
      this._schedule();
    }
  }

  /** Centre square of the feed — the aim box the user sees matches this crop. */
  _roi() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const side = Math.min(vw, vh);
    // 1:1 unless the camera is enormous, and then only by a whole factor.
    const factor = Math.ceil(side / MAX_DECODE_SIZE);
    return { sx: (vw - side) / 2, sy: (vh - side) / 2, side, target: Math.floor(side / factor) };
  }

  /** Draw the region of interest into the scratch canvas at decode size. */
  _paint(sx, sy, side, target) {
    if (this.canvas.width !== target) {
      this.canvas.width = target;
      this.canvas.height = target;
      this.ctx.imageSmoothingEnabled = false;
    }
    this.ctx.drawImage(this.video, sx, sy, side, side, 0, 0, target, target);
  }

  async _decodeCurrentFrame() {
    if (!this.video.videoWidth) return null;
    const { sx, sy, side, target } = this._roi();

    if (this.detector) {
      this._paint(sx, sy, side, target);
      const codes = await this.detector.detect(this.canvas);
      return codes.length ? codes[0].rawValue : null;
    }

    const id = this.nextDecodeId++;
    const answer = new Promise((resolve) => this.pendingDecodes.set(id, resolve));

    if (this.useBitmap) {
      const bitmap =
        target === side
          ? await createImageBitmap(this.video, sx, sy, side, side)
          : await createImageBitmap(this.video, sx, sy, side, side, {
              resizeWidth: target,
              resizeHeight: target,
              resizeQuality: 'pixelated',
            });
      this.worker.postMessage({ id, bitmap }, [bitmap]);
    } else {
      this._paint(sx, sy, side, target);
      const image = this.ctx.getImageData(0, 0, target, target);
      this.worker.postMessage({ id, buffer: image.data.buffer, width: target, height: target }, [image.data.buffer]);
    }

    return answer;
  }

  _ingest(text) {
    const frame = textToFrame(text);
    if (!frame) return;

    // A different sender, a re-send, or the same sender at a new density: any of
    // those re-cuts the file into blocks we cannot mix with what we already have.
    const restarted =
      !this.decoder ||
      this.session !== frame.sessionId ||
      this.decoder.totalLen !== frame.totalLen ||
      this.decoder.blockSize !== frame.blockSize;

    if (restarted) {
      this.reset();
      this.session = frame.sessionId;
      this.flags = frame.flags;
      this.decoder = new LTDecoder(frame.totalLen, frame.blockSize);
      if (this.onStatus) this.onStatus('Locked on — hold steady');
    }

    if (frame.type === FRAME_META) {
      if (!this.meta) {
        this.meta = frame.meta;
        if (this.onMeta) this.onMeta(frame.meta);
      }
      return;
    }

    if (frame.type !== FRAME_DATA) return;
    if (!this.decoder.add(frame.seed, frame.symbol)) return;
    if (!this.firstSymbolAt) this.firstSymbolAt = performance.now();
    this.framesDecoded++;

    this._emitProgress();

    if (this.decoder.done) this._finish();
  }

  _emitProgress() {
    if (!this.onProgress) return;
    const elapsed = Math.max(0.001, (performance.now() - this.firstSymbolAt) / 1000);
    const recovered = Math.min(this.decoder.totalLen, this.decoder.decodedCount * this.decoder.blockSize);
    this.onProgress({
      decoded: this.decoder.decodedCount,
      blocks: this.decoder.K,
      progress: this.decoder.progress,
      bytes: recovered,
      totalLen: this.decoder.totalLen,
      symbols: this.decoder.symbolsSeen,
      bytesPerSecond: recovered / elapsed,
    });
  }

  async _finish() {
    const payload = this.decoder.result();
    this.running = false;

    try {
      const bytes = this.flags & FLAG_GZIP ? await gunzip(payload) : payload;
      const meta = this.meta || {};
      // Verify the payload as it travelled, before any unbundling.
      const verified = meta.h ? (await sha256Hex(bytes)) === meta.h : null;

      // Names come from the manifest, never from the meta frame, which may have
      // had to shorten them to fit inside a QR code.
      const unpacked = this.flags & FLAG_BUNDLE ? unpackBundle(bytes) : null;
      const files = unpacked
        ? unpacked.map((file) => ({
            name: file.name,
            size: file.bytes.length,
            blob: new Blob([file.bytes], { type: file.type }),
          }))
        : [
            {
              name: meta.n || `photon-${this.session}.bin`,
              size: bytes.length,
              blob: new Blob([bytes], { type: meta.m || 'application/octet-stream' }),
            },
          ];

      if (this.onComplete) {
        this.onComplete({
          files,
          // Kept for single-file callers.
          blob: files[0].blob,
          name: files[0].name,
          size: bytes.length,
          verified,
          symbols: this.decoder.symbolsSeen,
          blocks: this.decoder.K,
        });
      }
    } catch (err) {
      if (this.onError) this.onError(err);
    } finally {
      this.stop();
    }
  }
}
