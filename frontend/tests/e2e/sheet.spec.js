// The transfer sheet must never be a wall the user cannot get past.
import { test, expect } from '@playwright/test';
import { ShareHubPage } from './pages/ShareHubPage.js';
import { TransferSheet } from './pages/TransferSheet.js';
import { fixtureFile } from './fixtures/files.js';

async function twoDevices(browser) {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const apps = pages.map((p) => new ShareHubPage(p));
  await Promise.all(apps.map((a) => a.goto()));
  return { contexts, apps };
}

test.describe('Transfer sheet', () => {
  let contexts = [];

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  test('scrolls internally, collapses, and closes', async ({ browser }) => {
    test.slow();
    const devices = await twoDevices(browser);
    contexts = devices.contexts;
    const [alice, bob] = devices.apps;
    const bobId = await bob.peerId();
    await expect(alice.peerCard(bobId)).toBeVisible({ timeout: 30_000 });

    const files = [
      fixtureFile('one.bin', 60_000, 2),
      fixtureFile('two.bin', 60_000, 3),
      fixtureFile('three.bin', 60_000, 4),
      fixtureFile('four.bin', 60_000, 5),
    ];
    const downloads = files.map(() => bob.page.waitForEvent('download', { timeout: 90_000 }));
    await alice.sendFiles(bobId, files.map((f) => f.path));
    await Promise.all(downloads);

    const sheet = new TransferSheet(bob.page);
    await expect(sheet.root).toHaveClass(/open/);

    // The list scrolls inside a fixed frame; the page behind must not take over.
    expect(await sheet.scrollBehaviour()).toMatch(/auto|scroll/);
    const withinViewport = await sheet.root.evaluate(
      (el) => Math.round(el.getBoundingClientRect().bottom) <= window.innerHeight + 1
    );
    expect(withinViewport, 'the sheet ran past the bottom of the screen').toBe(true);

    // It listened for touch only, so on a desktop there was no way to move it.
    await sheet.tapHandle();
    expect(await sheet.isCollapsed()).toBe(true);
    await expect(bob.radarPanel).toBeVisible();

    await sheet.tapHandle();
    expect(await sheet.isCollapsed()).toBe(false);

    await sheet.close();
    expect(await sheet.isOpen()).toBe(false);
  });

  test('a batch of files does not bury the screen in toasts', async ({ browser }) => {
    test.slow();
    const devices = await twoDevices(browser);
    contexts = devices.contexts;
    const [alice, bob] = devices.apps;
    const bobId = await bob.peerId();
    await expect(alice.peerCard(bobId)).toBeVisible({ timeout: 30_000 });

    const files = [
      fixtureFile('t1.bin', 40_000, 6),
      fixtureFile('t2.bin', 40_000, 7),
      fixtureFile('t3.bin', 40_000, 8),
      fixtureFile('t4.bin', 40_000, 9),
    ];
    const downloads = files.map(() => bob.page.waitForEvent('download', { timeout: 90_000 }));
    await alice.sendFiles(bobId, files.map((f) => f.path));
    await Promise.all(downloads);

    // Four files used to raise eight overlapping notifications.
    expect(await bob.toasts.count()).toBeLessThanOrEqual(3);
  });
});
