// Everything has to hold together down to 350px.
import { test, expect } from '@playwright/test';
import { ShareHubPage } from './pages/ShareHubPage.js';
import { PhotonHubStage } from './pages/PhotonHubStage.js';
import { fixtureFile } from './fixtures/files.js';

const WIDTHS = [350, 360, 390, 414, 768];

/** Anything sticking out sideways, named so a failure is actionable. */
async function overflowing(page) {
  return page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.offsetParent && el !== document.body) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        bad.push(`${el.id || el.className || el.tagName} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
      }
    }
    return { bad: bad.slice(0, 5), scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  });
}

test.describe('Responsive', () => {
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      const app = new ShareHubPage(page);
      await app.goto();

      for (const open of [() => app.openRadar(), () => app.openPhoton()]) {
        await open();
        const result = await overflowing(page);
        expect(result.bad, `overflowing elements at ${width}px`).toEqual([]);
        expect(result.scrollWidth).toBeLessThanOrEqual(result.innerWidth + 1);
      }
    });

    test(`the beam stage fits at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      const app = new ShareHubPage(page);
      const stage = new PhotonHubStage(page);
      await app.goto();
      await app.openPhoton();

      await stage.beam([fixtureFile(`fit-${width}.bin`, 15_000, width).path]);

      const result = await overflowing(page);
      expect(result.bad, `overflowing elements on the stage at ${width}px`).toEqual([]);
      expect(await stage.codeWidth()).toBeGreaterThan(100);
    });
  }
});
