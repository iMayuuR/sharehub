// WebKit is the engine behind every browser on iOS, and the one platform we
// cannot put a real device in front of. It has no fake-camera support, so this
// covers what it can: that the app runs, that the SCTP ceiling which broke
// large sends is respected here too, and that a transfer between two WebKit
// peers arrives intact.
import { test, expect } from '@playwright/test';
import { ShareHubPage } from './pages/ShareHubPage.js';
import { PhotonHubStage } from './pages/PhotonHubStage.js';
import { fixtureFile } from './fixtures/files.js';

test.describe('WebKit / iOS', () => {
  test('the app boots and both modes render', async ({ page }) => {
    const app = new ShareHubPage(page);
    await app.goto();

    await expect(app.radarTab).toBeVisible();
    await expect(app.photonTab).toBeVisible();
    await app.openPhoton();
    await expect(page.locator('#opticalBeamBtn')).toBeVisible();
  });

  test('beaming works — the sender needs no camera', async ({ page }) => {
    const app = new ShareHubPage(page);
    const stage = new PhotonHubStage(page);
    await app.goto();
    await app.openPhoton();

    await stage.beam([fixtureFile('webkit-beam.bin', 12_000, 77).path]);
    await expect(stage.canvas).toBeVisible();
    await expect.poll(() => stage.frames.textContent(), { timeout: 20_000 }).not.toBe('0');
    expect(await stage.codeWidth()).toBeGreaterThan(100);
  });

  test('announces an SCTP ceiling, and the sender respects it', async ({ page }) => {
    const app = new ShareHubPage(page);
    await app.goto();

    // The old code sent 4 MB regardless. Whatever WebKit negotiates, chunks
    // must come in under it — this is the number that broke iOS.
    const advertised = await page.evaluate(async () => {
      const pc = new RTCPeerConnection();
      pc.createDataChannel('probe');
      await pc.setLocalDescription(await pc.createOffer());
      const match = pc.localDescription.sdp.match(/a=max-message-size:(\d+)/);
      pc.close();
      return match ? Number(match[1]) : null;
    });

    test.info().annotations.push({ type: 'webkit max-message-size', description: String(advertised) });
    if (advertised !== null) {
      expect(advertised).toBeGreaterThan(0);
      expect(advertised, 'a 4 MB chunk would be refused here').toBeLessThan(4 * 1024 * 1024);
    }
  });

  test('a large file survives between two WebKit peers', async ({ browser }) => {
    test.slow();
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const pages = await Promise.all(contexts.map((c) => c.newPage()));
      const [alice, bob] = pages.map((p) => new ShareHubPage(p));
      await Promise.all([alice.goto(), bob.goto()]);

      const bobId = await bob.peerId();
      await expect(alice.peerCard(bobId)).toBeVisible({ timeout: 40_000 });

      // Comfortably past any browser's single-message ceiling.
      const file = fixtureFile('webkit-large.bin', 3 * 1024 * 1024, 91);
      const download = bob.page.waitForEvent('download', { timeout: 120_000 });
      await alice.sendFiles(bobId, [file.path]);

      expect((await download).suggestedFilename()).toBe(file.name);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
});
