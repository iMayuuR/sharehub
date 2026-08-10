import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';

import { encodeBase45, decodeBase45, base45Length, maxBytesForChars } from './base45.js';
import { LTEncoder, LTDecoder, symbolIndices } from './fountain.js';
import {
  packDataFrame,
  packMetaFrame,
  parseFrame,
  frameToText,
  textToFrame,
  maybeCompress,
  gunzip,
  sha256Hex,
  FRAME_DATA,
  FRAME_META,
  FLAG_GZIP,
  DATA_HEADER_SIZE,
} from './protocol.js';
import { makeQr, DENSITY_PRESETS } from './qr-render.js';
import { packBundle, unpackBundle, isBundle } from './bundle.js';

function seededBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Render a QR into a clean RGBA bitmap, the way a canvas would. */
function rasterize(qr, { scale = 3, quiet = 4 } = {}) {
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = ((row + quiet) * scale + y) * size + ((col + quiet) * scale + x);
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

describe('base45', () => {
  it('round-trips even and odd lengths', () => {
    for (const length of [0, 1, 2, 3, 17, 256, 1601]) {
      const bytes = seededBytes(length, length + 7);
      const text = encodeBase45(bytes);
      assert.equal(text.length, base45Length(length));
      assert.deepEqual(decodeBase45(text), bytes);
    }
  });

  it('only emits characters QR alphanumeric mode accepts', () => {
    const text = encodeBase45(seededBytes(4096, 3));
    assert.match(text, /^[0-9A-Z $%*+\-./:]*$/);
  });

  it('rejects malformed input instead of returning garbage', () => {
    assert.throws(() => decodeBase45('ABCD'), /truncated/);
    assert.throws(() => decodeBase45('ab_'), /bad character/);
    assert.throws(() => decodeBase45('::::::'), /overflow/);
  });

  it('maxBytesForChars is the inverse of base45Length', () => {
    for (let bytes = 0; bytes < 64; bytes++) {
      assert.equal(maxBytesForChars(base45Length(bytes)), bytes);
    }
  });
});

describe('wire format', () => {
  it('round-trips a data frame', () => {
    const symbol = seededBytes(64, 11);
    const frame = parseFrame(
      packDataFrame({ sessionId: 4242, flags: FLAG_GZIP, totalLen: 5000, blockSize: 64, seed: 99999, symbol })
    );
    assert.equal(frame.type, FRAME_DATA);
    assert.equal(frame.sessionId, 4242);
    assert.equal(frame.flags, FLAG_GZIP);
    assert.equal(frame.totalLen, 5000);
    assert.equal(frame.blockSize, 64);
    assert.equal(frame.seed, 99999);
    assert.deepEqual(new Uint8Array(frame.symbol), symbol);
  });

  it('round-trips a meta frame', () => {
    const meta = { n: 'holiday.jpg', m: 'image/jpeg', s: 12345, h: 'ab'.repeat(32) };
    const frame = parseFrame(packMetaFrame({ sessionId: 7, flags: 0, totalLen: 12345, blockSize: 600, meta }));
    assert.equal(frame.type, FRAME_META);
    assert.deepEqual(frame.meta, meta);
  });

  it('rejects foreign or corrupt payloads rather than misreading them', () => {
    assert.equal(textToFrame('HTTPS://EXAMPLE.COM'), null);
    assert.equal(textToFrame(''), null);
    assert.equal(parseFrame(new Uint8Array([1, 2, 3])), null);

    const truncated = packDataFrame({
      sessionId: 1,
      flags: 0,
      totalLen: 100,
      blockSize: 64,
      seed: 0,
      symbol: seededBytes(64, 2),
    }).subarray(0, 40);
    assert.equal(parseFrame(truncated), null);
  });
});

describe('fountain coding', () => {
  it('symbol selection is identical for sender and receiver', () => {
    for (const seed of [0, 5, 137, 99999]) {
      assert.deepEqual(symbolIndices(seed, 250), symbolIndices(seed, 250));
    }
  });

  it('the first K seeds are systematic, so a clean run costs exactly K frames', () => {
    const payload = seededBytes(40000, 5);
    const encoder = new LTEncoder(payload, 600);
    const decoder = new LTDecoder(payload.length, 600);

    for (let seed = 0; seed < encoder.K; seed++) decoder.add(seed, encoder.symbol(seed));

    assert.equal(decoder.done, true);
    assert.equal(decoder.symbolsSeen, encoder.K);
    assert.deepEqual(decoder.result(), payload);
  });

  it('recovers from a receiver that joins late and drops a third of the frames', () => {
    const payload = seededBytes(120000, 9);
    const blockSize = 600;
    const encoder = new LTEncoder(payload, blockSize);
    const decoder = new LTDecoder(payload.length, blockSize);

    let state = 12345;
    const rand = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);

    // Start well past the systematic prefix: pure fountain frames only.
    let seed = encoder.K * 3;
    let shown = 0;
    while (!decoder.done && shown < encoder.K * 10) {
      shown++;
      const current = seed++;
      if (rand() < 0.33) continue; // camera missed this one
      decoder.add(current, encoder.symbol(current));
    }

    assert.equal(decoder.done, true, 'decoder never converged');
    assert.deepEqual(decoder.result(), payload);
    const overhead = decoder.symbolsSeen / encoder.K;
    assert.ok(overhead < 1.35, `fountain overhead too high: ${overhead.toFixed(3)}`);
  });

  it('ignores duplicate frames, which is most of what a camera sees', () => {
    const payload = seededBytes(9000, 3);
    const encoder = new LTEncoder(payload, 600);
    const decoder = new LTDecoder(payload.length, 600);

    assert.equal(decoder.add(0, encoder.symbol(0)), true);
    assert.equal(decoder.add(0, encoder.symbol(0)), false);
    assert.equal(decoder.symbolsSeen, 1);
  });

  it('handles a payload smaller than one block', () => {
    const payload = seededBytes(37, 4);
    const encoder = new LTEncoder(payload, 600);
    const decoder = new LTDecoder(payload.length, 600);
    decoder.add(0, encoder.symbol(0));
    assert.equal(decoder.done, true);
    assert.deepEqual(decoder.result(), payload);
  });
});

describe('multi-file bundle', () => {
  it('round-trips several files with names and types intact', () => {
    const files = [
      { name: 'notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('hello light') },
      { name: 'photo.jpg', type: 'image/jpeg', bytes: seededBytes(5000, 3) },
      { name: 'empty.bin', type: 'application/octet-stream', bytes: new Uint8Array(0) },
    ];

    const unpacked = unpackBundle(packBundle(files));
    assert.equal(unpacked.length, 3);
    for (let i = 0; i < files.length; i++) {
      assert.equal(unpacked[i].name, files[i].name);
      assert.equal(unpacked[i].type, files[i].type);
      assert.deepEqual(new Uint8Array(unpacked[i].bytes), files[i].bytes);
    }
  });

  it('survives unicode filenames', () => {
    const files = [{ name: 'फोटो — copy (1).png', type: 'image/png', bytes: seededBytes(64, 8) }];
    assert.equal(unpackBundle(packBundle(files))[0].name, 'फोटो — copy (1).png');
  });

  it('refuses payloads that are not bundles', () => {
    assert.equal(isBundle(seededBytes(100, 1)), false);
    assert.equal(unpackBundle(seededBytes(100, 1)), null);
    assert.equal(unpackBundle(new Uint8Array(2)), null);
  });

  it('refuses a bundle whose manifest outruns the data', () => {
    const packed = packBundle([{ name: 'a.bin', type: '', bytes: seededBytes(500, 2) }]);
    assert.equal(unpackBundle(packed.subarray(0, packed.length - 100)), null);
  });
});

describe('compression and verification', () => {
  it('compresses compressible payloads and leaves noise alone', async () => {
    const text = new TextEncoder().encode('ShareHub optical transfer. '.repeat(500));
    const compressible = await maybeCompress(text);
    assert.equal(compressible.gzipped, true);
    assert.ok(compressible.bytes.length < text.length);
    assert.deepEqual(await gunzip(compressible.bytes), text);

    const noise = await maybeCompress(seededBytes(20000, 21));
    assert.equal(noise.gzipped, false);
  });

  it('hashes match what the receiver checks', async () => {
    const hash = await sha256Hex(new TextEncoder().encode('abc'));
    assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('end-to-end over a simulated optical channel', () => {
  for (const preset of DENSITY_PRESETS) {
    it(`carries a file at "${preset.id}" density through QR render and decode`, async () => {
      const original = seededBytes(24000, 77);
      const hash = await sha256Hex(original);
      const { bytes: payload, gzipped } = await maybeCompress(original);
      const blockSize = preset.bytes - DATA_HEADER_SIZE;

      const encoder = new LTEncoder(payload, blockSize);
      const decoder = new LTDecoder(payload.length, blockSize);
      const sessionId = 999;
      const flags = gzipped ? FLAG_GZIP : 0;

      let meta = null;
      let seed = 0;
      for (let frame = 0; !decoder.done && frame < encoder.K * 3 + 8; frame++) {
        let bytes;
        if (frame % 16 === 0) {
          bytes = packMetaFrame({
            sessionId,
            flags,
            totalLen: payload.length,
            blockSize,
            meta: { n: 'sample.bin', m: 'application/octet-stream', s: original.length, h: hash },
          });
        } else {
          const current = seed++;
          bytes = packDataFrame({
            sessionId,
            flags,
            totalLen: payload.length,
            blockSize,
            seed: current,
            symbol: encoder.symbol(current),
          });
        }

        // Screen → camera: render the QR, then read it back as a bitmap would.
        const qr = makeQr(frameToText(bytes), preset.ecc);
        const { data, size } = rasterize(qr);
        const scanned = jsQR(data, size, size, { inversionAttempts: 'dontInvert' });
        assert.ok(scanned, `QR at ${preset.id} density failed to decode`);

        const parsed = textToFrame(scanned.data);
        assert.ok(parsed, 'scanned frame did not parse');
        if (parsed.type === FRAME_META) meta = parsed.meta;
        else decoder.add(parsed.seed, parsed.symbol);
      }

      assert.equal(decoder.done, true);
      assert.ok(meta, 'never caught a meta frame');

      const received = flags & FLAG_GZIP ? await gunzip(decoder.result()) : decoder.result();
      assert.deepEqual(received, original);
      assert.equal(await sha256Hex(received), meta.h);
    });
  }
});
