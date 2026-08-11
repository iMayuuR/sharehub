// Page object for the ShareHub shell: identity, mode tabs, share tray.

export class ShareHubPage {
  constructor(page) {
    this.page = page;

    this.radarTab = page.locator('#modeTabRadar');
    this.photonTab = page.locator('#modeTabPhoton');
    this.radarPanel = page.locator('#radarPanel');
    this.photonPanel = page.locator('#photonPanel');
    this.offlineBanner = page.locator('#offlineBanner');
    this.shareTray = page.locator('#shareTray');
    this.peerCards = page.locator('#peersContainer .peer-card:not(.empty-state)');
    this.toasts = page.locator('#toast-container .toast');
    this.profileButton = page.locator('#myProfileBtn');
  }

  async goto() {
    await this.page.goto('/');
    // The splash holds until CSS custom properties and fonts have settled.
    await this.page.locator('#app-splash').waitFor({ state: 'detached', timeout: 30_000 });
  }

  /** This device's own peer id, which is how the other side names its card. */
  peerId() {
    return this.page.evaluate(() => window.myIdentityId);
  }

  peerCard(peerId) {
    return this.page.locator(`#peer-${peerId}`);
  }

  peerName(peerId) {
    return this.peerCard(peerId).locator('.peer-info h3');
  }

  async openPhoton() {
    await this.photonTab.click();
    await this.photonPanel.waitFor({ state: 'visible' });
  }

  async openRadar() {
    await this.radarTab.click();
    await this.radarPanel.waitFor({ state: 'visible' });
  }

  async rename(name) {
    await this.profileButton.click();
    await this.page.locator('#editNameInput').fill(name);
    await this.page.locator('#saveProfileBtn').click();
  }

  /** Queue files to a peer through the card's own Send button. */
  async sendFiles(peerId, paths) {
    const chooser = this.page.waitForEvent('filechooser');
    await this.peerCard(peerId).locator('.btn-send').click();
    await (await chooser).setFiles(paths);
  }
}
