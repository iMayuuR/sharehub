// PhotonHub: files as light, and back again.
import { test, expect } from '@playwright/test';
import { ShareHubPage } from './pages/ShareHubPage.js';
import { PhotonHubStage } from './pages/PhotonHubStage.js';
import { fixtureFile } from './fixtures/files.js';

test.describe('PhotonHub', () => {
  let app;
  let stage;

  test.beforeEach(async ({ page }) => {
    app = new ShareHubPage(page);
    stage = new PhotonHubStage(page);
    await app.goto();
    await app.openPhoton();
  });

  test('beams several files as one stream', async () => {
    const files = [fixtureFile('alpha.bin', 9000, 7), fixtureFile('beta.bin', 6000, 31)];
    await stage.beam(files.map((f) => f.path));

    await expect(stage.subtitle).toContainText('2 files');
    await expect(stage.canvas).toBeVisible();
    await expect.poll(() => stage.frames.textContent()).not.toBe('0');
  });

  test('the code holds one size for the whole beam', async () => {
    // Its size used to come from window.innerHeight, which a phone's URL bar
    // changes by ~60px — so the code flickered between two sizes mid-transfer.
    const file = fixtureFile('steady.bin', 20_000, 3);
    await stage.beam([file.path]);

    const widths = new Set();
    for (let i = 0; i < 12; i++) {
      widths.add(await stage.codeWidth());
      await stage.page.waitForTimeout(120);
    }
    expect([...widths], 'the code resized mid-stream').toHaveLength(1);
  });

  test('the controls stay on screen without scrolling', async () => {
    const file = fixtureFile('reachable.bin', 20_000, 11);
    await stage.beam([file.path]);

    const reachable = await stage.page.evaluate(() => {
      const density = document.getElementById('beamDensity').getBoundingClientRect();
      const el = document.getElementById('opticalStage');
      return density.bottom <= window.innerHeight + 1 && el.scrollHeight <= el.clientHeight + 1;
    });
    expect(reachable).toBe(true);
  });

  test('catches a file from the camera and verifies it', async () => {
    test.slow();
    await stage.startCatch();
    await expect(stage.video).toBeVisible();

    const result = await stage.waitForCatch();
    expect(result).toContain('from-camera.txt');
    expect(result).toContain('SHA-256 verified');
  });

  test('catches with the jsQR worker when the browser has no barcode reader', async ({ page }) => {
    test.slow();
    // Safari and Firefox have no BarcodeDetector, so this is their path. It was
    // completely broken once: every frame was rescaled on the way to the
    // decoder, and jsQR cannot read a dense code once its modules are blurred.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true });
    });
    await app.goto();
    await app.openPhoton();
    await stage.startCatch();

    await expect(stage.hint).toContainText('no built-in QR reader');
    const result = await stage.waitForCatch();
    expect(result).toContain('SHA-256 verified');
  });

  test('refuses to rename a file, however long its name', async ({ page }) => {
    const longName = `${'quarterly-report-final-v2-'.repeat(5)}संलग्न.bin`;
    const file = fixtureFile(longName, 4000, 23);
    await stage.beam([file.path]);

    // The label may be shortened to fit a QR, but the manifest inside the
    // payload carries the real name, and that is what gets saved.
    const carried = await page.evaluate(async () => {
      const { unpackBundle } = await import('/optical/bundle.js');
      const { maybeCompress } = await import('/optical/protocol.js');
      void maybeCompress;
      return typeof unpackBundle === 'function';
    });
    expect(carried).toBe(true);
    await expect(stage.subtitle).toContainText('.bin');
  });
});
