// qr-render.js — turns a frame's text into crisp screen pixels.
//
// Camera decoding lives or dies on module edges, so the canvas is always sized
// to an exact whole number of device pixels per QR module. A half-pixel module
// smears under the compositor and costs far more frames than a slightly smaller
// code does.

import qrcode from 'qrcode-generator';

/**
 * Payload bytes per frame. Bigger codes move more per frame but need a steadier
 * hand, a closer camera, and a bigger screen — hence the ladder.
 */
export const DENSITY_PRESETS = [
  { id: 'safe', label: 'Safe', bytes: 320, ecc: 'M', hint: 'Small screens, shaky hands' },
  { id: 'normal', label: 'Normal', bytes: 640, ecc: 'M', hint: 'Phone to phone' },
  { id: 'dense', label: 'Dense', bytes: 1024, ecc: 'L', hint: 'Laptop to phone' },
  { id: 'max', label: 'Max', bytes: 1600, ecc: 'L', hint: 'Big monitor, steady mount' },
];

export const DEFAULT_DENSITY = 'normal';

export function densityById(id) {
  return DENSITY_PRESETS.find((preset) => preset.id === id) || DENSITY_PRESETS.find((preset) => preset.id === DEFAULT_DENSITY);
}

/** Module count of the one version whose low-ECC block layout readers disagree on. */
const BROKEN_VERSION_MODULES = 109; // version 23

/**
 * @param {string} text Base45 payload (QR alphanumeric mode)
 * @param {'L'|'M'|'Q'|'H'} ecc
 */
export function makeQr(text, ecc = 'M') {
  let qr = build(text, ecc, 0); // 0 = pick the smallest version that fits

  // Version 23 at ECC L is a known bad cell: the error-correction block layout
  // this encoder emits is not the one decoders expect, and nothing reads the
  // result back. Every other version/level pair round-trips, so step over it.
  if (ecc === 'L' && qr.getModuleCount() === BROKEN_VERSION_MODULES) {
    qr = build(text, ecc, 24);
  }
  return qr;
}

function build(text, ecc, typeNumber) {
  const qr = qrcode(typeNumber, ecc);
  qr.addData(text, 'Alphanumeric');
  qr.make();
  return qr;
}

/**
 * Paint a QR onto a canvas at an integer device-pixel module size.
 * @returns {{cssSize:number, moduleCount:number, modulePx:number}}
 */
export function drawQr(canvas, qr, { targetCss, quiet = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const moduleCount = qr.getModuleCount();
  const span = moduleCount + quiet * 2;
  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);

  const modulePx = Math.max(2, Math.floor((targetCss * dpr) / span));
  const backing = span * modulePx;

  if (canvas.width !== backing || canvas.height !== backing) {
    canvas.width = backing;
    canvas.height = backing;
  }
  const cssSize = backing / dpr;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, backing, backing);
  ctx.fillStyle = dark;

  const origin = quiet * modulePx;
  for (let row = 0; row < moduleCount; row++) {
    // Coalesce horizontal runs — one fillRect per run instead of per module.
    let runStart = -1;
    for (let col = 0; col <= moduleCount; col++) {
      const on = col < moduleCount && qr.isDark(row, col);
      if (on && runStart < 0) runStart = col;
      if (!on && runStart >= 0) {
        ctx.fillRect(origin + runStart * modulePx, origin + row * modulePx, (col - runStart) * modulePx, modulePx);
        runStart = -1;
      }
    }
  }

  return { cssSize, moduleCount, modulePx };
}
