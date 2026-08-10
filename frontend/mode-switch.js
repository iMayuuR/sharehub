// mode-switch.js — Radar (needs a network) vs Lightwave (needs none).
//
// The point of Lightwave is that it works when nothing else does, so the app
// should land there by itself the moment the network goes away instead of
// leaving the user staring at a radar that will never find anything. A manual
// tap pins the choice for the rest of the session — being moved between tabs
// while you are trying to do something is worse than a stale tab.

const MODE_KEY = 'shareHubMode';

export const RADAR = 'radar';
export const LIGHTWAVE = 'lightwave';

export class ModeSwitch {
  /**
   * @param {{onChange?: (mode: string, reason: string) => void, onNetworkChange?: (online: boolean) => void}} hooks
   */
  constructor({ onChange, onNetworkChange } = {}) {
    this.onChange = onChange || (() => {});
    this.onNetworkChange = onNetworkChange || (() => {});

    this.tabs = [...document.querySelectorAll('.mode-tab')];
    this.panels = {
      [RADAR]: document.getElementById('radarPanel'),
      [LIGHTWAVE]: document.getElementById('lightwavePanel'),
    };
    this.banner = document.getElementById('offlineBanner');
    this.bannerText = document.getElementById('offlineBannerText');

    this.pinned = false;
    this.mode = null;

    for (const tab of this.tabs) {
      tab.addEventListener('click', () => {
        this.pinned = true;
        this.set(tab.dataset.mode, 'user');
      });
    }

    window.addEventListener('online', () => this._onNetwork(true));
    window.addEventListener('offline', () => this._onNetwork(false));

    const remembered = localStorage.getItem(MODE_KEY);
    const startOffline = navigator.onLine === false;
    this.set(startOffline ? LIGHTWAVE : remembered === LIGHTWAVE ? LIGHTWAVE : RADAR, startOffline ? 'offline' : 'restore');
    this._renderBanner(navigator.onLine !== false);
  }

  /**
   * @param {string} mode
   * @param {'user'|'offline'|'restore'|'auto'} reason
   */
  set(mode, reason = 'auto') {
    const next = mode === LIGHTWAVE ? LIGHTWAVE : RADAR;
    if (next === this.mode) return;
    this.mode = next;

    for (const tab of this.tabs) {
      const active = tab.dataset.mode === next;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    for (const [name, panel] of Object.entries(this.panels)) {
      panel?.classList.toggle('active', name === next);
    }

    if (reason === 'user') localStorage.setItem(MODE_KEY, next);
    this.onChange(next, reason);
  }

  /** True while the tab should be treated as reachable. */
  get online() {
    return navigator.onLine !== false;
  }

  _onNetwork(online) {
    this._renderBanner(online);
    this.onNetworkChange(online);
    // Only ever pull the user somewhere they cannot already be stuck.
    if (!online && !this.pinned) this.set(LIGHTWAVE, 'offline');
  }

  _renderBanner(online) {
    if (!this.banner) return;
    this.banner.classList.toggle('active', !online);
    if (this.bannerText) {
      this.bannerText.textContent = 'No network — Lightwave still works, it only needs a screen and a camera.';
    }
  }
}
