// decode-worker.js — jsQR off the main thread.
//
// Used wherever the native BarcodeDetector is missing (Safari, Firefox). Decode
// is the slow half of receiving, and running it on the main thread would stall
// the camera preview and the progress UI at exactly the moment the user is
// trying to hold the phone steady.

import jsQR from 'jsqr';

let surface = null;
let ctx = null;

function canvasFor(width, height) {
  if (!surface || surface.width !== width || surface.height !== height) {
    surface = new OffscreenCanvas(width, height);
    ctx = surface.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
  }
  return ctx;
}

self.onmessage = (event) => {
  const { id, bitmap, buffer, width, height } = event.data;

  try {
    let pixels;
    let w;
    let h;

    if (bitmap) {
      // 1:1 — the sender already sized the bitmap; rescaling here would blur
      // module edges and cost us the dense codes.
      w = bitmap.width;
      h = bitmap.height;
      const context = canvasFor(w, h);
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      pixels = context.getImageData(0, 0, w, h).data;
    } else {
      pixels = new Uint8ClampedArray(buffer);
      w = width;
      h = height;
    }

    // The stream is always dark-on-light, so skip the inverted second pass.
    const found = jsQR(pixels, w, h, { inversionAttempts: 'dontInvert' });
    self.postMessage({ id, text: found ? found.data : null });
  } catch (err) {
    self.postMessage({ id, text: null, error: String(err) });
  }
};
