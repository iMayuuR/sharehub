// Two devices finding each other, and staying found.
import { test, expect } from '@playwright/test';
import { ShareHubPage } from './pages/ShareHubPage.js';
import { TransferSheet } from './pages/TransferSheet.js';
import { fixtureFile } from './fixtures/files.js';

/** Two contexts, not two tabs: identity lives in localStorage, and tabs sharing
 *  a profile share a peer id — each would then ignore the other as itself. */
async function twoDevices(browser) {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const apps = pages.map((p) => new ShareHubPage(p));
  await Promise.all(apps.map((a) => a.goto()));
  return { contexts, pages, apps };
}

test.describe('Radar discovery', () => {
  let contexts = [];

  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  test('two devices see each other by name', async ({ browser }) => {
    const devices = await twoDevices(browser);
    contexts = devices.contexts;
    const [alice, bob] = devices.apps;

    const bobId = await bob.peerId();
    const aliceId = await alice.peerId();

    await expect(alice.peerCard(bobId)).toBeVisible({ timeout: 30_000 });
    await expect(bob.peerCard(aliceId)).toBeVisible({ timeout: 30_000 });

    // A peer that has joined but not yet announced used to read "Unknown Device".
    await expect(alice.peerName(bobId)).not.toContainText('Unknown');
    await expect(alice.peerName(bobId)).not.toHaveText('');
  });

  test('a custom name reaches the other device straight away', async ({ browser }) => {
    const devices = await twoDevices(browser);
    contexts = devices.contexts;
    const [alice, bob] = devices.apps;
    const aliceId = await alice.peerId();

    await expect(bob.peerCard(aliceId)).toBeVisible({ timeout: 30_000 });

    const chosen = `Mayur Desk ${Date.now() % 1000}`;
    await alice.rename(chosen);

    await expect(bob.peerName(aliceId)).toHaveText(chosen, { timeout: 20_000 });
    // And it is this device's identity from now on, not just for this render.
    expect(await alice.page.evaluate(() => JSON.parse(localStorage.getItem('sharehub-identity')).name)).toBe(chosen);
  });

  test('a peer card survives a brief disconnect', async ({ browser }) => {
    const devices = await twoDevices(browser);
    contexts = devices.contexts;
    const [alice, bob] = devices.apps;
    const aliceId = await alice.peerId();

    await expect(bob.peerCard(aliceId)).toBeVisible({ timeout: 30_000 });

    // A phone backgrounding for a moment drops its socket. Announcing that as a
    // departure made devices vanish from the radar and pop back.
    let vanished = 0;
    const watching = (async () => {
      for (let i = 0; i < 40; i++) {
        if ((await bob.peerCard(aliceId).count()) === 0) vanished++;
        await bob.page.waitForTimeout(250);
      }
    })();

    await devices.contexts[0].setOffline(true);
    await alice.page.waitForTimeout(2500);
    await devices.contexts[0].setOffline(false);
    await watching;

    expect(vanished, 'the card blinked out while the socket reconnected').toBe(0);
    await expect(bob.peerCard(aliceId)).toBeVisible();
  });

  test('files larger than one SCTP message still arrive, intact', async ({ browser }) => {
    test.slow();
    const devices = await twoDevices(browser);
    contexts = devices.contexts;
    const [alice, bob] = devices.apps;
    const bobId = await bob.peerId();
    await expect(alice.peerCard(bobId)).toBeVisible({ timeout: 30_000 });

    // Chrome negotiates a 256 KB ceiling. A 4 MB chunk was rejected on the very
    // first send, mistaken for back-pressure, and hung the whole queue.
    const files = [
      fixtureFile('big-one.bin', 4 * 1024 * 1024, 5),
      fixtureFile('small-two.bin', 90_000, 19),
      fixtureFile('mid-three.bin', 700_000, 41),
    ];

    const downloads = files.map(() => bob.page.waitForEvent('download', { timeout: 120_000 }));
    await alice.sendFiles(bobId, files.map((f) => f.path));

    const landed = await Promise.all(downloads);
    const names = landed.map((d) => d.suggestedFilename()).sort();
    expect(names).toEqual(files.map((f) => f.name).sort());

    const sheet = new TransferSheet(alice.page);
    await expect(sheet.items).toHaveCount(files.length);
    for (const text of await sheet.percentages()) expect(text).toContain('Sent');
  });
});
