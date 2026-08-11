// Renders the fake camera stream once, before any test needs it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCameraStream } from './fixtures/camera.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  const text = new TextEncoder().encode('PhotonHub camera fixture — a line of text.\n'.repeat(60));
  const stream = await buildCameraStream(
    [{ name: 'from-camera.txt', type: 'text/plain', bytes: text }],
    path.join(here, '.artifacts', 'camera.y4m')
  );
  process.env.E2E_CAMERA_FILE = 'from-camera.txt';
  process.env.E2E_CAMERA_BLOCKS = String(stream.blocks);
}
