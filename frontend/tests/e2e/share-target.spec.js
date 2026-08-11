// The Android share sheet hands files over by POSTing them at the app.
import { test, expect } from '@playwright/test';
import { ShareHubPage } from './pages/ShareHubPage.js';
import { PhotonHubStage } from './pages/PhotonHubStage.js';
import { fixtureFile } from './fixtures/files.js';

test.describe('Share target', () => {
  test('shared files land in a tray that both modes can see', async ({ page }) => {
    const app = new ShareHubPage(page);
    const stage = new PhotonHubStage(page);
    await app.goto();
    await page.evaluate(() => navigator.serviceWorker.ready);

    const files = [fixtureFile('holiday.jpg', 120_000, 12), fixtureFile('receipt.pdf', 40_000, 13)];

    // Exactly the form the manifest's share_target declares.
    await page.evaluate(() => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/share';
      form.enctype = 'multipart/form-data';
      const input = document.createElement('input');
      input.type = 'file';
      input.name = 'files';
      input.multiple = true;
      input.id = 'shareProbeInput';
      form.appendChild(input);
      document.body.appendChild(form);
    });
    await page.locator('#shareProbeInput').setInputFiles(files.map((f) => f.path));
    await Promise.all([
      page.waitForNavigation(),
      page.evaluate(() => document.getElementById('shareProbeInput').form.submit()),
    ]);
    await page.locator('#app-splash').waitFor({ state: 'detached', timeout: 30_000 });

    await expect(app.shareTray).toBeVisible();
    await expect(app.shareTray).toContainText('2 files');

    // The message used to be written into the radar's empty state, which lives
    // inside the Radar tab — a user on PhotonHub saw nothing at all.
    await expect(page.locator('#emptyState')).toContainText('Searching for nearby');
    await app.openPhoton();
    await expect(app.shareTray).toBeVisible();

    await page.locator('#shareTrayBeam').click();
    await expect(stage.stage).toBeVisible();
    await expect(stage.subtitle).toContainText('2 files');
  });
});
