// Page object for the fullscreen Beam / Catch stage.

export class PhotonHubStage {
  constructor(page) {
    this.page = page;
    this.stage = page.locator('#opticalStage');
    this.subtitle = page.locator('#opticalStageSub');
    this.exitButton = page.locator('#opticalExitBtn');

    this.beamButton = page.locator('#opticalBeamBtn');
    this.catchButton = page.locator('#opticalCatchBtn');
    this.canvas = page.locator('#opticalCanvas');
    this.frames = page.locator('#beamFrames');
    this.densityBar = page.locator('#beamDensity');
    this.fpsSlider = page.locator('#beamFpsInput');

    this.video = page.locator('#opticalVideo');
    this.percent = page.locator('#catchPercent');
    this.blocks = page.locator('#catchBlocks');
    this.result = page.locator('#catchResult');
    this.hint = page.locator('#catchHint');
  }

  async beam(paths) {
    const chooser = this.page.waitForEvent('filechooser');
    await this.beamButton.click();
    await (await chooser).setFiles(paths);
    await this.stage.waitFor({ state: 'visible' });
    // Wait for the first painted frame rather than a fixed delay.
    await this.page.waitForFunction(() => document.getElementById('opticalCanvas')?.width > 0);
  }

  async startCatch() {
    await this.catchButton.click();
    await this.stage.waitFor({ state: 'visible' });
  }

  /** Width the code is actually drawn at, in CSS pixels. */
  codeWidth() {
    return this.canvas.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  }

  async waitForCatch(timeout = 90_000) {
    await this.result.waitFor({ state: 'visible', timeout });
    return (await this.result.innerText()).replace(/\s+/g, ' ').trim();
  }

  async exit() {
    await this.exitButton.click();
    await this.stage.waitFor({ state: 'hidden' });
  }
}
