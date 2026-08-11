// Full-loop test: the real OpticalSender paints frames onto a canvas, jsQR reads
// those pixels back the way a camera would, and the real OpticalReceiver
// reassembles the file. Only the glass in between is faked.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

/** Minimal 2D context that records what drawQr paints into an RGBA buffer. */
class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.imageSmoothingEnabled = true;
    this.data = null;
    this.size = 0;
  }

  _ensure() {
    // A real canvas throws away its bitmap whenever width changes; match that.
    if (this.size !== this.canvas.width) {
      this.size = this.canvas.width;
      this.data = new Uint8ClampedArray(this.size * this.size * 4).fill(255);
    }
  }

  fillRect(x, y, w, h) {
    this._ensure();
    const shade = this.fillStyle === '#ffffff' ? 255 : 0;
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const px = (row * this.size + col) * 4;
        this.data[px] = shade;
        this.data[px + 1] = shade;
        this.data[px + 2] = shade;
        this.data[px + 3] = 255;
      }
    }
  }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.style = {};
    this._ctx = null;
  }

  getContext() {
    if (!this._ctx) this._ctx = new FakeContext(this);
    return this._ctx;
  }

  scan() {
    const ctx = this._ctx;
    if (!ctx?.data) return null;
    return jsQR(ctx.data, ctx.size, ctx.size, { inversionAttempts: 'dontInvert' });
  }
}

let pendingFrames = [];

before(() => {
  // The engines expect a browser: a document to hang visibility listeners on and
  // an animation clock. Both are pumped by hand so the test stays deterministic.
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    createElement: () => new FakeCanvas(),
  };
  globalThis.requestAnimationFrame = (callback) => pendingFrames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
});

/** Run the sender's own animation loop for `count` painted frames. */
function pump(sender, canvas, onFrame, count) {
  let clock = 0;
  let painted = 0;
  let guard = 0;

  while (painted < count && guard++ < count * 20) {
    const due = pendingFrames;
    pendingFrames = [];
    if (!due.length) break;
    clock += 1000; // far past any fps gate, so every callback paints
    for (const callback of due) {
      const before = sender.frameCount;
      callback(clock);
      if (sender.frameCount > before) {
        painted++;
        onFrame(canvas);
      }
    }
  }
  return painted;
}

describe('optical pipeline', () => {
  it('beams a real file and catches it back, byte for byte', async () => {
    const { OpticalSender } = await import('./sender.js');
    const { OpticalReceiver } = await import('./receiver.js');

    const original = new TextEncoder().encode(
      'ShareHub optical transfer — a file that crossed the room as light.\n'.repeat(60)
    );
    const file = new File([original], 'letter.txt', { type: 'text/plain' });

    const canvas = new FakeCanvas();
    const sender = new OpticalSender(canvas);
    sender.setDensity('normal');
    sender.setTargetSize(420);
    const loaded = await sender.load(file);
    assert.equal(loaded.name, 'letter.txt');

    const receiver = new OpticalReceiver({ srcObject: null, setAttribute() {}, play() {} });
    let finished = null;
    receiver.onComplete = (result) => {
      finished = result;
    };

    pendingFrames = [];
    sender.start();

    // Drop every fourth frame — a camera never sees all of them.
    let shown = 0;
    const painted = pump(sender, canvas, (surface) => {
      shown++;
      if (shown % 4 === 0) return;
      const scanned = surface.scan();
      assert.ok(scanned, `frame ${shown} did not decode`);
      receiver._ingest(scanned.data);
    }, sender.blockCount * 2 + 40);

    sender.stop();
    assert.ok(painted > 0, 'sender painted nothing');

    // _finish is async: let its hash + blob work settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(finished, 'receiver never completed');
    assert.equal(finished.name, 'letter.txt');
    assert.equal(finished.verified, true);
    assert.deepEqual(new Uint8Array(await finished.blob.arrayBuffer()), original);
  });

  it('beams several files as one stream and hands them back separately', async () => {
    const { OpticalSender } = await import('./sender.js');
    const { OpticalReceiver } = await import('./receiver.js');

    const sources = [
      new File([new TextEncoder().encode('first file over light\n'.repeat(40))], 'one.txt', { type: 'text/plain' }),
      new File([new Uint8Array(3000).map((_, i) => (i * 13) & 0xff)], 'two.bin', { type: 'application/octet-stream' }),
      new File([new TextEncoder().encode('third')], 'three.txt', { type: 'text/plain' }),
    ];

    const canvas = new FakeCanvas();
    const sender = new OpticalSender(canvas);
    sender.setDensity('normal');
    sender.setTargetSize(420);
    const loaded = await sender.load(sources);
    assert.equal(loaded.count, 3);
    assert.equal(loaded.name, '3 files');

    const receiver = new OpticalReceiver({ srcObject: null, setAttribute() {}, play() {} });
    let finished = null;
    receiver.onComplete = (result) => {
      finished = result;
    };

    pendingFrames = [];
    sender.start();
    pump(sender, canvas, (surface) => {
      const scanned = surface.scan();
      if (scanned) receiver._ingest(scanned.data);
    }, sender.blockCount * 2 + 40);
    sender.stop();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(finished, 'receiver never completed');
    assert.equal(finished.verified, true);
    assert.equal(finished.files.length, 3);
    assert.deepEqual(finished.files.map((f) => f.name), ['one.txt', 'two.bin', 'three.txt']);

    for (let i = 0; i < sources.length; i++) {
      const expected = new Uint8Array(await sources[i].arrayBuffer());
      assert.deepEqual(new Uint8Array(await finished.files[i].blob.arrayBuffer()), expected, `file ${i} differs`);
    }
  });

  it('delivers the name and hash before a small file finishes', async () => {
    const { OpticalSender } = await import('./sender.js');
    const { OpticalReceiver } = await import('./receiver.js');

    // Incompressible and small: the systematic prefix finishes in ~10 frames, so
    // a fixed 1-in-16 meta cadence would never come round and the file would
    // land unnamed and unverified.
    const original = new Uint8Array(6000).map((_, i) => (i * 61) & 0xff);
    const canvas = new FakeCanvas();
    const sender = new OpticalSender(canvas);
    sender.setDensity('normal');
    sender.setTargetSize(420);
    await sender.load(new File([original], 'small.bin', { type: 'application/octet-stream' }));
    assert.ok(sender.blockCount < 16, `expected a short stream, got K=${sender.blockCount}`);

    const receiver = new OpticalReceiver({ srcObject: null, setAttribute() {}, play() {} });
    let finished = null;
    receiver.onComplete = (result) => {
      finished = result;
    };

    pendingFrames = [];
    sender.start();
    let index = 0;
    pump(sender, canvas, (surface) => {
      // Skip the opening frame: a real camera never catches the very first one.
      if (index++ === 0) return;
      const scanned = surface.scan();
      if (scanned) receiver._ingest(scanned.data);
    }, sender.blockCount * 3);
    sender.stop();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(finished, 'receiver never completed');
    assert.equal(finished.name, 'small.bin');
    assert.equal(finished.verified, true);
  });

  it('draws every frame at the same size', async () => {
    const { OpticalSender } = await import('./sender.js');

    const canvas = new FakeCanvas();
    const sender = new OpticalSender(canvas);
    sender.setDensity('normal');
    sender.setTargetSize(420);
    // Small file, so meta frames come round often enough to be jarring.
    await sender.load(new File([new Uint8Array(5000).fill(3)], 'steady.bin'));

    pendingFrames = [];
    sender.start();
    const widths = new Set();
    pump(sender, canvas, (surface) => widths.add(surface.width), 12);
    sender.stop();

    // A code that changes size every few frames makes the receiver re-aim.
    assert.equal(widths.size, 1, `canvas resized mid-stream: ${[...widths].join(', ')}px`);
  });

  it('never renames a file, however long its name', async () => {
    const { OpticalSender } = await import('./sender.js');
    const { OpticalReceiver } = await import('./receiver.js');

    // Longer than a meta frame could ever carry, plus characters that survive
    // no encoding by accident.
    const name = `${'quarterly-report-final-FINAL-v2-'.repeat(6)}संलग्न (1).pdf`;
    const original = new Uint8Array(4000).map((_, i) => (i * 29) & 0xff);

    const canvas = new FakeCanvas();
    const sender = new OpticalSender(canvas);
    sender.setDensity('normal');
    sender.setTargetSize(420);
    await sender.load(new File([original], name, { type: 'application/pdf' }));

    const receiver = new OpticalReceiver({ srcObject: null, setAttribute() {}, play() {} });
    let finished = null;
    receiver.onComplete = (result) => {
      finished = result;
    };

    pendingFrames = [];
    sender.start();
    pump(sender, canvas, (surface) => {
      const scanned = surface.scan();
      if (scanned) receiver._ingest(scanned.data);
    }, sender.blockCount * 2 + 30);
    sender.stop();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(finished, 'receiver never completed');
    assert.equal(finished.files.length, 1);
    assert.equal(finished.files[0].name, name, 'filename was altered in transit');
    assert.equal(finished.verified, true);
    assert.deepEqual(new Uint8Array(await finished.files[0].blob.arrayBuffer()), original);
  });

  it('recovers when the sender changes density mid-beam', async () => {
    const { OpticalSender } = await import('./sender.js');
    const { OpticalReceiver } = await import('./receiver.js');

    const original = new Uint8Array(5000).map((_, i) => (i * 37) & 0xff);
    const canvas = new FakeCanvas();
    const sender = new OpticalSender(canvas);
    sender.setDensity('safe');
    sender.setTargetSize(420);
    await sender.load(new File([original], 'switch.bin', { type: 'application/octet-stream' }));

    const receiver = new OpticalReceiver({ srcObject: null, setAttribute() {}, play() {} });
    let finished = null;
    receiver.onComplete = (result) => {
      finished = result;
    };

    const feed = (surface) => {
      const scanned = surface.scan();
      if (scanned) receiver._ingest(scanned.data);
    };

    pendingFrames = [];
    sender.start();
    pump(sender, canvas, feed, 5);
    const halfway = receiver.decoder.decodedCount;
    assert.ok(halfway > 0, 'nothing decoded before the switch');

    // Re-cutting the file into different blocks must not wedge the receiver.
    sender.setDensity('dense');
    pump(sender, canvas, feed, sender.blockCount * 2 + 20);
    sender.stop();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(finished, 'receiver never recovered from the density change');
    assert.deepEqual(new Uint8Array(await finished.blob.arrayBuffer()), original);
  });

  it('starts over when the sender switches to a different file', async () => {
    const { OpticalSender } = await import('./sender.js');
    const { OpticalReceiver } = await import('./receiver.js');

    const canvas = new FakeCanvas();
    const sender = new OpticalSender(canvas);
    sender.setTargetSize(420);
    await sender.load(new File([new Uint8Array(3000).fill(7)], 'first.bin'));

    const receiver = new OpticalReceiver({ srcObject: null, setAttribute() {}, play() {} });

    pendingFrames = [];
    sender.start();
    pump(sender, canvas, (surface) => {
      const scanned = surface.scan();
      if (scanned) receiver._ingest(scanned.data);
    }, 3);
    sender.stop();

    const firstSession = receiver.session;
    assert.ok(receiver.decoder, 'receiver never locked on');

    const second = new OpticalSender(canvas);
    second.setTargetSize(420);
    await second.load(new File([new Uint8Array(9000).fill(9)], 'second.bin'));

    pendingFrames = [];
    second.start();
    pump(second, canvas, (surface) => {
      const scanned = surface.scan();
      if (scanned) receiver._ingest(scanned.data);
    }, 3);
    second.stop();

    assert.notEqual(receiver.session, firstSession);
    assert.equal(receiver.decoder.totalLen, second.payload.length);
    assert.ok(receiver.decoder.decodedCount <= receiver.decoder.K);
  });
});
