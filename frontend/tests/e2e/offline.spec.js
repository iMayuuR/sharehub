// The app itself has to survive the network going away.
import { test, expect } from '@playwright/test';
import { ShareHubPage } from './pages/ShareHubPage.js';

test.describe('Offline', () => {
  test('the service worker keeps a complete copy on the first visit', async ({ page }) => {
    const app = new ShareHubPage(page);
    await app.goto();
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Content-hashed filenames cannot be listed ahead of time, so the worker
    // reads the shell for them, then those bundles for the chunks they load.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const entries = [];
      for (const name of names) {
        const cache = await caches.open(name);
        entries.push(...(await cache.keys()).map((r) => new URL(r.url).pathname));
      }
      return entries;
    });

    expect(cached).toContain('/');
    expect(cached.some((p) => /^\/assets\/index-.*\.js$/.test(p)), `no bundle in ${cached}`).toBe(true);
    // Only ever named inside the main bundle, never in the HTML.
    expect(cached.some((p) => p.includes('decode-worker')), `no decode worker in ${cached}`).toBe(true);
  });

  test('the page still opens with no network', async ({ page, context }) => {
    const app = new ShareHubPage(page);
    await app.goto();
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload();

    await expect(page.locator('#modeTabPhoton')).toBeVisible();
    await expect(page.locator('#opticalBeamBtn')).toBeVisible();
  });

  test('a cold start with no network lands on PhotonHub', async ({ page, context }) => {
    const app = new ShareHubPage(page);
    await app.goto();
    await page.evaluate(() => navigator.serviceWorker.ready);

    // A phone in aeroplane mode reports navigator.onLine === false; emulated
    // offline does not survive a reload, so state it outright.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    });
    await context.setOffline(true);
    await page.reload();

    await expect(page.locator('#photonPanel')).toBeVisible();
    await expect(page.locator('#offlineBanner')).toBeVisible();
    await expect(page.locator('#radarPanel')).toBeHidden();
  });
});
