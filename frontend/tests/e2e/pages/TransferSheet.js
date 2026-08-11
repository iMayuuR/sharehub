// Page object for the bottom sheet that reports transfers.

export class TransferSheet {
  constructor(page) {
    this.page = page;
    this.root = page.locator('#transferSheet');
    this.body = page.locator('#transferContent');
    this.handle = page.locator('#sheetHandle');
    this.closeButton = page.locator('#sheetCloseBtn');
    this.items = page.locator('#transferContent .transfer-item');
    this.title = page.locator('#transferTitle');
  }

  isOpen() {
    return this.root.evaluate((el) => el.classList.contains('open'));
  }

  isCollapsed() {
    return this.root.evaluate((el) => el.classList.contains('collapsed'));
  }

  percentages() {
    return this.items.locator('.transfer-percent').allTextContents();
  }

  /** The grip responds to pointer events, so mouse and touch behave alike. */
  async tapHandle() {
    await this.handle.click();
    await this.page.waitForTimeout(400); // the slide is 350ms
  }

  async close() {
    await this.closeButton.click();
    await this.page.waitForTimeout(400);
  }

  /** True when the list has more content than its frame — it must scroll itself. */
  overflows() {
    return this.body.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  }

  scrollBehaviour() {
    return this.body.evaluate((el) => getComputedStyle(el).overflowY);
  }
}
