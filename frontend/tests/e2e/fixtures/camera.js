// Builds a Y4M video of a PhotonHub stream, to feed Chrome's fake webcam.
//
// The receiving half of PhotonHub cannot be tested without a camera pointed at
// a moving QR code. Rather than mock the decoder — which would test nothing —
// the real encoder renders the real frames, and Chrome plays them back as if
// they arrived through a lens.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { makeQr } from '../../../optical/qr-render.js';
import { LTEncoder } from '../../../optical/fountain.js';
import { packBundle } from '../../../optical/bundle.js';
import {
  packDataFrame,
  packMetaFrame,
  frameToText,
  sha256Hex,
  maybeCompress,
  FLAG_GZIP,
  FLAG_BUNDLE,
  DATA_HEADER_SIZE,
} from '../../../optical/protocol.js';

const FRAME_SIDE = 480;
const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;
const REPEATS_PER_CODE = 3; // a real camera sees each code for several frames

/** Paint one QR into a luma plane, centred, at whole-pixel module size. */
function lumaFor(qr) {
  const modules = qr.getModuleCount();
  const quiet = 4;
  const span = modules + quiet * 2;
  const modulePx = Math.floor(FRAME_SIDE / span);
  const offset = Math.floor((FRAME_SIDE - span * modulePx) / 2);

  const luma = new Uint8Array(FRAME_SIDE * FRAME_SIDE).fill(255);
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let y = 0; y < modulePx; y++) {
        for (let x = 0; x < modulePx; x++) {
          const py = offset + (quiet + row) * modulePx + y;
          const px = offset + (quiet + col) * modulePx + x;
          luma[py * FRAME_SIDE + px] = 0;
        }
      }
    }
  }
  return luma;
}

/**
 * @param {{name: string, bytes: Uint8Array}[]} files
 * @param {string} outputPath
 * @returns {Promise<{name: string, sha256: string, blocks: number}>}
 */
export async function buildCameraStream(files, outputPath) {
  const payloadSource = packBundle(
    files.map((file) => ({ name: file.name, type: file.type || 'text/plain', bytes: file.bytes }))
  );
  const hash = await sha256Hex(payloadSource);
  const { bytes: payload, gzipped } = await maybeCompress(payloadSource);

  const blockSize = 640 - DATA_HEADER_SIZE;
  const encoder = new LTEncoder(payload, blockSize);
  const flags = (gzipped ? FLAG_GZIP : 0) | FLAG_BUNDLE;
  const sessionId = 4242;

  // Same adaptive cadence the sender uses, so a short stream still carries its
  // metadata before the last block lands.
  const cadence = Math.max(2, Math.min(16, Math.floor(encoder.K / 3)));
  const totalSize = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const label = files.length > 1 ? `${files.length} files` : files[0].name;

  const chunks = [Buffer.from(`YUV4MPEG2 W${VIDEO_WIDTH} H${VIDEO_HEIGHT} F30:1 Ip A1:1 C420mpeg2\n`)];
  const chroma = Buffer.alloc((VIDEO_WIDTH / 2) * (VIDEO_HEIGHT / 2), 128);
  const xOffset = (VIDEO_WIDTH - FRAME_SIDE) / 2;

  let seed = 0;
  for (let frame = 0; frame < encoder.K * 3 + 12; frame++) {
    const bytes =
      frame % cadence === 0
        ? packMetaFrame({
            sessionId,
            flags,
            totalLen: payload.length,
            blockSize,
            meta: { n: label, m: 'text/plain', s: totalSize, h: hash, c: files.length },
          })
        : packDataFrame({
            sessionId,
            flags,
            totalLen: payload.length,
            blockSize,
            seed,
            symbol: encoder.symbol(seed++),
          });

    const luma = lumaFor(makeQr(frameToText(bytes), 'M'));
    const plane = Buffer.alloc(VIDEO_WIDTH * VIDEO_HEIGHT, 255);
    for (let row = 0; row < FRAME_SIDE; row++) {
      for (let col = 0; col < FRAME_SIDE; col++) {
        plane[row * VIDEO_WIDTH + xOffset + col] = luma[row * FRAME_SIDE + col];
      }
    }
    for (let repeat = 0; repeat < REPEATS_PER_CODE; repeat++) {
      chunks.push(Buffer.from('FRAME\n'), plane, chroma, chroma);
    }
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.concat(chunks));
  return { name: label, sha256: hash, blocks: encoder.K };
}
