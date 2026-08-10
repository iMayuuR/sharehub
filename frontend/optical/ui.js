// ui.js — the Beam / Catch screens of Lightwave.
//
// Everything below is wiring: the codec lives in fountain.js and protocol.js,
// the two engines in sender.js and receiver.js. This file owns the DOM, the
// stage lifecycle, and making sure a camera or a canvas is never left running
// after the user walks away.

import { OpticalSender, MAX_FILE_BYTES } from './sender.js';
import { OpticalReceiver } from './receiver.js';
import { DENSITY_PRESETS, DEFAULT_DENSITY } from './qr-render.js';
import { createWakeLock } from './wake-lock.js';

const FPS_KEY = 'opticalFps';
const DENSITY_KEY = 'opticalDensity';

export class OpticalUI {
  /**
   * @param {{onToast?: (message: string) => void}} [hooks]
   */
  constructor({ onToast } = {}) {
    this.onToast = onToast || (() => {});

    this.beamBtn = document.getElementById('opticalBeamBtn');
    this.catchBtn = document.getElementById('opticalCatchBtn');
    this.note = document.getElementById('opticalNote');
    this.fileInput = document.getElementById('opticalFileInput');

    this.stage = document.getElementById('opticalStage');
    this.stageTitle = document.getElementById('opticalStageTitle');
    this.stageSub = document.getElementById('opticalStageSub');
    this.exitBtn = document.getElementById('opticalExitBtn');

    this.beamView = document.getElementById('opticalBeamView');
    this.canvas = document.getElementById('opticalCanvas');
    this.beamPass = document.getElementById('beamPass');
    this.beamFrames = document.getElementById('beamFrames');
    this.beamRate = document.getElementById('beamRate');
    this.beamLoop = document.getElementById('beamLoop');
    this.fpsInput = document.getElementById('beamFpsInput');
    this.fpsValue = document.getElementById('beamFpsValue');
    this.densityBar = document.getElementById('beamDensity');

    this.catchView = document.getElementById('opticalCatchView');
    this.video = document.getElementById('opticalVideo');
    this.catchFill = document.getElementById('catchFill');
    this.catchPercent = document.getElementById('catchPercent');
    this.catchBlocks = document.getElementById('catchBlocks');
    this.catchSpeed = document.getElementById('catchSpeed');
    this.catchLeft = document.getElementById('catchLeft');
    this.catchResult = document.getElementById('catchResult');
    this.catchHint = document.getElementById('catchHint');

    this.sender = null;
    this.receiver = null;
    this.catchWakeLock = createWakeLock();
    this.objectUrls = [];

    this.fps = clampFps(Number(localStorage.getItem(FPS_KEY)) || 12);
    this.densityId = localStorage.getItem(DENSITY_KEY) || DEFAULT_DENSITY;

    this._onResize = this._onResize.bind(this);
    this._setup();
  }

  _setup() {
    if (!this.stage) return;

    this.beamBtn?.addEventListener('click', () => {
      // Files arriving from the OS share sheet skip the picker entirely.
      const pending = window.pendingShareFiles || [];
      if (pending.length) {
        window.pendingShareFiles = [];
        this._startBeam(pending.slice());
        return;
      }
      this.fileInput.value = '';
      this.fileInput.click();
    });
    this.fileInput?.addEventListener('change', (event) => {
      const files = Array.from(event.target.files || []);
      if (files.length) this._startBeam(files);
    });

    this.catchBtn?.addEventListener('click', () => this._startCatch());
    this.exitBtn.addEventListener('click', () => this._closeStage());

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.stage.classList.contains('active')) this._closeStage();
    });

    this._buildDensityBar();

    this.fpsInput.value = String(this.fps);
    this.fpsValue.textContent = `${this.fps} fps`;
    this.fpsInput.addEventListener('input', () => {
      this.fps = clampFps(Number(this.fpsInput.value));
      this.fpsValue.textContent = `${this.fps} fps`;
      localStorage.setItem(FPS_KEY, String(this.fps));
      if (this.sender) {
        this.sender.setFps(this.fps);
        this._updateBeamSubtitle();
      }
    });

    window.addEventListener('resize', this._onResize);
    this.refreshNote();
  }

  /** Reflect what this device can actually do — camera needs a secure context. */
  refreshNote() {
    if (this.note) this.note.textContent = describeSupport();
  }

  /** Files handed over from elsewhere in the app (OS share sheet, paste). */
  beamFiles(files) {
    if (files?.length) this._startBeam(Array.from(files));
  }

  get busy() {
    return this.stage?.classList.contains('active') || false;
  }

  _buildDensityBar() {
    this.densityBar.innerHTML = '';
    for (const preset of DENSITY_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = preset.label;
      button.title = preset.hint;
      button.dataset.id = preset.id;
      button.classList.toggle('active', preset.id === this.densityId);
      button.addEventListener('click', () => {
        this.densityId = preset.id;
        localStorage.setItem(DENSITY_KEY, preset.id);
        for (const sibling of this.densityBar.children) {
          sibling.classList.toggle('active', sibling.dataset.id === preset.id);
        }
        if (this.sender) {
          this.sender.setDensity(preset.id);
          this._updateBeamSubtitle();
        }
      });
      this.densityBar.appendChild(button);
    }
  }

  // --- Beam ------------------------------------------------------------

  async _startBeam(files) {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_FILE_BYTES) {
      this.onToast(`⚠️ Too large for Lightwave — max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`);
      return;
    }

    // Beaming again without exiting first would leave the old animation loop
    // running and both senders painting the same canvas.
    this.sender?.stop();
    this._openStage('beam', 'Beaming', 'Preparing…');

    this.sender = new OpticalSender(this.canvas);
    this.sender.setFps(this.fps);
    this.sender.setDensity(this.densityId);
    this.sender.onStats = (stats) => this._renderBeamStats(stats);

    try {
      const loaded = await this.sender.load(files);
      this._layoutBeam();
      this.sender.start();
      this._updateBeamSubtitle(loaded);
      if (loaded.count > 1) this.onToast(`🔦 Beaming ${loaded.count} files as one stream`);
    } catch (err) {
      this.onToast(`⚠️ ${err.message}`);
      this._closeStage();
    }
  }

  _updateBeamSubtitle(loaded) {
    if (!this.sender?.encoder) return;
    if (loaded) this.beamFile = loaded;
    const packed = this.beamFile?.gzipped ? ' · zipped' : '';
    this.stageSub.textContent =
      `${this.beamFile?.name || 'File'} · ${formatBytes(this.beamFile?.size || 0)}${packed} · ~${formatDuration(this.sender.passSeconds)} per pass`;
    this.beamLoop.textContent = formatDuration(this.sender.passSeconds);
  }

  _renderBeamStats(stats) {
    this.beamPass.textContent = `${Math.round(stats.passProgress * 100)}%`;
    this.beamFrames.textContent = String(stats.frames);
    this.beamRate.textContent = stats.actualFps.toFixed(1);
  }

  /** Give the code as much of the viewport as the surrounding chrome allows. */
  _layoutBeam() {
    if (!this.sender) return;
    const width = Math.min(this.stage.clientWidth - 52, 520);
    const height = window.innerHeight - 300;
    this.sender.setTargetSize(Math.max(160, Math.min(width, height)));
  }

  _onResize() {
    if (this.sender && this.stage.classList.contains('active')) this._layoutBeam();
  }

  // --- Catch -----------------------------------------------------------

  async _startCatch() {
    this.receiver?.stop();
    this._openStage('catch', 'Catching', 'Starting camera…');
    this._resetCatchUI();

    this.receiver = new OpticalReceiver(this.video);
    this.receiver.onStatus = (status) => {
      this.stageSub.textContent = status;
    };
    this.receiver.onMeta = (meta) => {
      this.stageSub.textContent = `${meta.n} · ${formatBytes(meta.s)}`;
    };
    this.receiver.onProgress = (progress) => this._renderCatchProgress(progress);
    this.receiver.onComplete = (result) => this._renderCatchResult(result);
    this.receiver.onError = (err) => {
      this.catchHint.textContent = `Decoder hiccup: ${err.message || err}`;
    };

    try {
      await this.receiver.start();
      this.catchWakeLock.start();
      this.stageSub.textContent = 'Looking for a code…';
      // Worth surfacing: the two decoders differ by roughly an order of
      // magnitude, which is most of the difference between a fast and a slow catch.
      this.catchHint.textContent =
        this.receiver.backend === 'native'
          ? 'Fill the frame with the code and hold steady. Missed frames only cost time.'
          : 'Fill the frame with the code and hold steady. This browser has no built-in QR reader, so expect a slower catch.';
    } catch (err) {
      this._renderCatchError(err);
    }
  }

  _resetCatchUI() {
    this.catchFill.style.width = '0%';
    this.catchPercent.textContent = '0%';
    this.catchBlocks.textContent = '0 / 0';
    this.catchSpeed.textContent = '—';
    this.catchLeft.textContent = '—';
    this.catchResult.className = 'optical-result';
    this.catchResult.innerHTML = '';
    this.catchHint.textContent = 'Fill the frame with the code and hold steady. Missed frames only cost time.';
    this.video.style.display = '';
    this._revokeUrls();
  }

  _renderCatchProgress(progress) {
    const percent = Math.round(progress.progress * 100);
    this.catchFill.style.width = `${percent}%`;
    this.catchPercent.textContent = `${percent}%`;
    this.catchBlocks.textContent = `${progress.decoded} / ${progress.blocks}`;
    this.catchSpeed.textContent = `${formatBytes(progress.bytesPerSecond)}/s`;

    const remaining = progress.totalLen - progress.bytes;
    this.catchLeft.textContent =
      progress.bytesPerSecond > 0 ? formatDuration(remaining / progress.bytesPerSecond) : '—';
  }

  _renderCatchResult(result) {
    this.catchWakeLock.stop();
    this.catchFill.style.width = '100%';
    this.catchPercent.textContent = '100%';
    this.video.style.display = 'none';

    const verdict =
      result.verified === true
        ? '✅ SHA-256 verified'
        : result.verified === false
          ? '⚠️ Checksum mismatch — may be damaged'
          : 'ℹ️ No checksum in the stream';

    const files = result.files?.length ? result.files : [{ name: result.name, size: result.size, blob: result.blob }];
    const many = files.length > 1;

    this.catchResult.className = `optical-result active${result.verified === false ? ' error' : ''}`;
    this.catchResult.innerHTML = `
      <span class="optical-result-title"></span>
      <span class="optical-result-sub"></span>
      <div class="optical-result-files"></div>
      <button class="btn btn-primary" data-role="save">Save ${many ? 'all' : 'file'}</button>
      <button class="btn btn-text" data-role="again">Catch another</button>
    `;
    this.catchResult.querySelector('.optical-result-title').textContent = many
      ? `${files.length} files received`
      : files[0].name;
    this.catchResult.querySelector('.optical-result-sub').textContent =
      `${formatBytes(result.size)} · ${verdict} · ${result.symbols} frames for ${result.blocks} blocks`;

    const list = this.catchResult.querySelector('.optical-result-files');
    const links = files.map((file) => {
      const url = URL.createObjectURL(file.blob);
      this.objectUrls.push(url);

      const row = document.createElement('a');
      row.className = 'optical-result-file';
      row.href = url;
      row.download = file.name;
      row.innerHTML = '<span class="optical-result-file-name"></span><span class="optical-result-file-size"></span>';
      row.querySelector('.optical-result-file-name').textContent = file.name;
      row.querySelector('.optical-result-file-size').textContent = formatBytes(file.size);
      list.appendChild(row);
      return row;
    });
    if (!many) list.classList.add('single');

    const saveAll = () => {
      // Sequential, spaced out: browsers throttle a burst of programmatic saves.
      links.forEach((link, index) => setTimeout(() => link.click(), index * 350));
    };
    this.catchResult.querySelector('[data-role="save"]').addEventListener('click', saveAll);
    this.catchResult.querySelector('[data-role="again"]').addEventListener('click', () => this._startCatch());

    this.catchHint.textContent = 'Received over light — nothing touched the network.';
    this.stageSub.textContent = 'Done';

    // A single file saves itself; a pile of them waits for a deliberate tap.
    if (!many) links[0].click();
    this.onToast(many ? `📥 ${files.length} files received over light!` : `📥 "${files[0].name}" received over light!`);
  }

  _renderCatchError(err) {
    const message =
      err?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access and try again.'
        : err?.name === 'NotFoundError'
          ? 'No camera found on this device.'
          : err?.message || String(err);

    this.stageSub.textContent = 'Camera unavailable';
    this.catchResult.className = 'optical-result active error';
    this.catchResult.innerHTML =
      '<span class="optical-result-title">Cannot start the camera</span><span class="optical-result-sub"></span>';
    this.catchResult.querySelector('.optical-result-sub').textContent = message;
  }

  // --- Stage lifecycle -------------------------------------------------

  _openStage(mode, title, subtitle) {
    this.stageTitle.textContent = title;
    this.stageSub.textContent = subtitle;
    this.beamView.classList.toggle('active', mode === 'beam');
    this.catchView.classList.toggle('active', mode === 'catch');
    this.stage.classList.add('active');
    document.body.classList.add('stage-open');
  }

  _closeStage() {
    this.stage.classList.remove('active');
    document.body.classList.remove('stage-open');
    if (this.sender) {
      this.sender.stop();
      this.sender = null;
    }
    if (this.receiver) {
      this.receiver.stop();
      this.receiver = null;
    }
    this.catchWakeLock.stop();
    this._revokeUrls();
  }

  _revokeUrls() {
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }
}

function clampFps(fps) {
  return Math.max(4, Math.min(24, Math.round(fps) || 12));
}

function describeSupport() {
  if (!window.isSecureContext) {
    return 'Beaming works anywhere. Catching needs an https page — the camera is blocked on plain http.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Beaming works here. This browser exposes no camera, so catch on the other device.';
  }
  return 'Slow but unstoppable — best for documents, photos and short clips. Pick several files and they travel as one stream.';
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
