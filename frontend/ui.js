// ui.js
import { identityForPeer } from './identity.js';


/** How long a finished sheet lingers before it tidies itself away. */
const AUTO_DISMISS_MS = 4000;
/** Beyond this the stack stops being a notification and becomes a wall. */
const MAX_TOASTS = 3;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export class UIManager {
  constructor(onPeerClick) {
    this.peersContainer = document.getElementById('peersContainer');
    this.emptyState = document.getElementById('emptyState');

    this.myProfileBtn = document.getElementById('myProfileBtn');
    this.myName = document.getElementById('myName');
    this.myAvatar = document.getElementById('myAvatar');

    this.profileModal = document.getElementById('profileModal');
    this.editNameInput = document.getElementById('editNameInput');
    this.editAvatarPreview = document.getElementById('editAvatarPreview');
    this.saveProfileBtn = document.getElementById('saveProfileBtn');
    this.closeProfileBtn = document.getElementById('closeProfileBtn');
    this.randomizeAvatarBtn = document.getElementById('randomizeAvatarBtn');

    this.transferSheet = document.getElementById('transferSheet');
    this.transferContent = document.getElementById('transferContent');
    this.transferStatus = document.getElementById('transferStatus');
    this.transferTitle = document.getElementById('transferTitle');
    this.fileInput = document.getElementById('fileInput');
    this.fileInput.multiple = true;
    this.clearTransfersBtn = document.getElementById('clearTransfersBtn');

    this.mainReceiveBtn = document.getElementById('mainReceiveBtn');
    this.pairModal = document.getElementById('pairModal');
    this.closePairBtn = document.getElementById('closePairBtn');
    this.qrCodeContainer = document.getElementById('qrCodeContainer');
    this.myRoomCodeEl = document.getElementById('myRoomCode');
    this.copyRoomCodeBtn = document.getElementById('copyRoomCodeBtn');
    this.joinRoomInput = document.getElementById('joinRoomInput');
    this.joinRoomBtn = document.getElementById('joinRoomBtn');

    this.onPeerClick = onPeerClick;
    this.onJoinRoom = null;
    this.sheetPinned = false;
    this._autoDismissTimer = null;
    this.activeTransfers = new Map(); // key: transferId, value: { peerId, filename, direction, progress, totalSize, item }
    this.roomCode = generateRoomCode();
    this.selectedPeerId = null;

    this.setupEvents();
  }

  setupEvents() {
    this.myProfileBtn.addEventListener('click', () => {
      this.profileModal.classList.add('active');
    });

    this.closeProfileBtn.addEventListener('click', () => {
      this.profileModal.classList.remove('active');
    });

    this.editNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.saveProfileBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeProfileBtn.click(); }
    });

    const setupOverlayClose = (modalOverlay, closeCallback) => {
      if (!modalOverlay) return;
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeCallback();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalOverlay.classList.contains('active')) {
          closeCallback();
        }
      });
    };

    setupOverlayClose(this.profileModal, () => this.closeProfileBtn.click());

    // --- Pair Modal ---
    const closePair = () => {
      this.pairModal.classList.remove('active');
    };

    const showPairModal = () => {
      const pairUrl = `${window.location.origin}/?room=${this.roomCode}`;
      this.myRoomCodeEl.textContent = this.roomCode;
      this.qrCodeContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(pairUrl)}" alt="QR Code" style="display:block; border-radius: 8px;" />`;
      this.pairModal.classList.add('active');
      if (this.onJoinRoom) this.onJoinRoom(this.roomCode);
    };

    if (this.mainReceiveBtn) this.mainReceiveBtn.addEventListener('click', showPairModal);
    if (this.closePairBtn) {
      this.closePairBtn.addEventListener('click', closePair);
      setupOverlayClose(this.pairModal, closePair);
    }

    if (this.copyRoomCodeBtn) {
      this.copyRoomCodeBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.roomCode).then(() => {
          this.copyRoomCodeBtn.textContent = '✅';
          setTimeout(() => this.copyRoomCodeBtn.textContent = '📋', 2000);
        });
      });
    }

    if (this.joinRoomBtn) {
      const doJoin = () => {
        const code = this.joinRoomInput.value.toUpperCase().trim();
        if (code.length < 4) return;
        if (this.onJoinRoom) this.onJoinRoom(code);
        this.joinRoomInput.value = '';
        closePair();
      };
      this.joinRoomBtn.addEventListener('click', doJoin);
      this.joinRoomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doJoin(); }
      });
    }

    if (this.joinRoomInput) {
      this.joinRoomInput.addEventListener('input', () => {
        this.joinRoomInput.value = this.joinRoomInput.value.toUpperCase();
      });
    }

    this.setupSheetGestures();

    if (this.clearTransfersBtn) {
      this.clearTransfersBtn.addEventListener('click', () => {
        // Remove all transfer items
        this.activeTransfers.forEach((value, key) => {
          if (value.item && value.item.parentNode) {
            value.item.remove();
          }
        });
        this.activeTransfers.clear();
        this.transferStatus.style.display = 'block';
        this.transferTitle.textContent = "Ready to Transfer";
        this.clearTransfersBtn.style.display = 'none';
        setTimeout(() => this.hideTransferSheet(), 200);
      });
    }
  }

  /**
   * The sheet used to listen for touch only, so on a desktop there was no way
   * to get it out of the way at all, and it sat over the peer cards. Pointer
   * events cover mouse and touch alike: tap the grip to collapse to a bar,
   * drag it down to dismiss.
   */
  setupSheetGestures() {
    const handle = document.getElementById('sheetHandle');
    const close = document.getElementById('sheetCloseBtn');
    if (!handle) return;

    close?.addEventListener('click', () => this.hideTransferSheet());

    let startY = 0;
    let dragged = false;

    handle.addEventListener('pointerdown', (event) => {
      startY = event.clientY;
      dragged = false;
      handle.setPointerCapture(event.pointerId);
      this.transferSheet.classList.add('dragging');
    });

    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const moved = event.clientY - startY;
      if (Math.abs(moved) > 6) dragged = true;
      if (moved > 90) {
        handle.releasePointerCapture(event.pointerId);
        this.transferSheet.classList.remove('dragging');
        this.hideTransferSheet();
      } else if (moved > 30) {
        this.collapseTransferSheet(true);
      } else if (moved < -30) {
        this.collapseTransferSheet(false);
      }
    });

    const finish = (event) => {
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      this.transferSheet.classList.remove('dragging');
      // A tap, not a drag, toggles.
      if (!dragged) this.collapseTransferSheet(!this.transferSheet.classList.contains('collapsed'));
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  /** Collapse to a bar rather than hiding, so progress stays glanceable. */
  collapseTransferSheet(collapsed) {
    this.sheetPinned = true;
    this.transferSheet.classList.toggle('collapsed', collapsed);
    const footer = document.getElementById('appFooter');
    if (footer) footer.style.paddingBottom = collapsed ? '90px' : '260px';
  }

  /** Everything finished: get out of the way, unless the user has taken charge. */
  _scheduleAutoDismiss() {
    clearTimeout(this._autoDismissTimer);
    const transfers = [...this.activeTransfers.values()];
    if (!transfers.length || transfers.some((t) => t.progress < 100)) return;

    this._autoDismissTimer = setTimeout(() => {
      if (this.sheetPinned) return;
      const stillDone = [...this.activeTransfers.values()].every((t) => t.progress >= 100);
      if (stillDone) this.hideTransferSheet();
    }, AUTO_DISMISS_MS);
  }

  // --- Toast Notification ---
  showToast(message, duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    // Saying the same thing twice is never worth two toasts.
    const existing = [...container.children].find((el) => el.textContent === message);
    if (existing) {
      clearTimeout(existing._timer);
      existing._timer = setTimeout(() => {
        existing.classList.remove('show');
        setTimeout(() => existing.remove(), 300);
      }, duration);
      return;
    }

    // A batch of files used to raise a toast per file per stage and bury the
    // screen. The sheet is where the detail belongs; keep the stack shallow.
    while (container.children.length >= MAX_TOASTS) container.firstElementChild.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));

    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- Peer Selection ---
  selectPeer(peerId) {
    // Remove previous selection
    if (this.selectedPeerId) {
      const prev = document.getElementById(`peer-${this.selectedPeerId}`);
      if (prev) prev.classList.remove('selected');
    }
    this.selectedPeerId = peerId;
    const card = document.getElementById(`peer-${peerId}`);
    if (card) card.classList.add('selected');
  }

  setIdentity(identity) {
    this.myName.textContent = identity.name;
    this.myAvatar.textContent = identity.avatar;
    this.editNameInput.value = identity.name;
    this.editAvatarPreview.textContent = identity.avatar;
  }

  addPeer(peerId, name, avatar) {
    const fallback = identityForPeer(peerId);
    name = name || fallback.name;
    avatar = avatar || fallback.avatar;
    const existingCard = document.getElementById(`peer-${peerId}`);
    if (existingCard) {
      existingCard.querySelector('.avatar').textContent = avatar;
      existingCard.querySelector('.peer-info h3').textContent = name;
      return;
    }

    this.emptyState.style.display = 'none';

    const card = document.createElement('div');
    card.className = 'peer-card';
    card.id = `peer-${peerId}`;

    card.innerHTML = `
      <div class="avatar"></div>
      <div class="peer-info">
        <h3></h3>
        <p class="peer-status">Ready to receive</p>
      </div>
      <button class="btn-send">Send Files</button>
    `;

    card.querySelector('.avatar').textContent = avatar;
    card.querySelector('.peer-info h3').textContent = name;

    // Click card to select
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-send')) return; // Don't select on button click
      this.selectPeer(peerId);
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0 && this.onPeerClick) {
        this.selectPeer(peerId);
        const files = Array.from(e.dataTransfer.files);
        this.onPeerClick(peerId, files.length === 1 ? files[0] : files);
      }
    });

    const sendBtn = card.querySelector('.btn-send');
    sendBtn.addEventListener('click', () => {
      this.selectPeer(peerId);

      if (window.pendingShareFiles && window.pendingShareFiles.length > 0) {
        const pending = window.pendingShareFiles.slice();
        window.pendingShareFiles = [];
        if (this.onPeerClick) {
          this.onPeerClick(peerId, pending.length === 1 ? pending[0] : pending);
        }
        // The share tray owns this message now, so the radar's own empty state
        // is left exactly as the markup declared it.
        document.getElementById('shareTray')?.classList.remove('active');
        return;
      }

      this.fileInput.onchange = (e) => {
        if (e.target.files.length > 0 && this.onPeerClick) {
          const files = Array.from(e.target.files);
          this.showTransferSheet();
          this.onPeerClick(peerId, files.length === 1 ? files[0] : files);
          this.fileInput.value = '';
        }
      };
      this.fileInput.click();
    });

    this.peersContainer.appendChild(card);
  }

  removePeer(peerId) {
    const card = document.getElementById(`peer-${peerId}`);
    if (card) this.peersContainer.removeChild(card);
    if (this.selectedPeerId === peerId) this.selectedPeerId = null;

    if (this.peersContainer.querySelectorAll('.peer-card:not(.empty-state)').length === 0) {
      this.emptyState.style.display = 'flex';
    }
  }

  // Update peer card status text
  setPeerStatus(peerId, statusText) {
    const card = document.getElementById(`peer-${peerId}`);
    if (!card) return;
    const statusEl = card.querySelector('.peer-status');
    if (statusEl) statusEl.textContent = statusText;
  }

  // --- Transfer Management ---
  showTransferSheet() {
    clearTimeout(this._autoDismissTimer);
    this.transferSheet.classList.remove('collapsed');
    this.transferSheet.classList.add('open');
    // Push footer above the sheet
    const footer = document.getElementById('appFooter');
    if (footer) footer.style.paddingBottom = '260px';

    // Enable smooth scrolling
    this.transferContent.style.scrollBehavior = 'smooth';
  }

  hideTransferSheet() {
    clearTimeout(this._autoDismissTimer);
    this.sheetPinned = false;
    this.transferSheet.classList.remove('open', 'collapsed');
    const footer = document.getElementById('appFooter');
    if (footer) footer.style.paddingBottom = '30px';
  }

  /**
   * Update progress for a file transfer
   * @param {string} peerId - The peer ID
   * @param {string} filename - The filename
   * @param {number} progress - Progress percentage (0-100) or -1 for cancelled
   * @param {number} totalSize - Total file size in bytes
   * @param {'send'|'receive'} direction - Transfer direction
   */
  updateProgress(peerId, filename, progress, totalSize, direction = 'send') {
    // Generate a unique transfer ID based on peer, direction, and filename
    // Using a hash-like approach to avoid excessively long IDs
    const transferId = `transfer-${peerId}-${direction}-${filename}`;

    // Handle cancellation
    if (progress === -1) {
      // Remove the transfer if it exists
      if (this.activeTransfers.has(transferId)) {
        const transferData = this.activeTransfers.get(transferId);
        if (transferData.item && transferData.item.parentNode) {
          transferData.item.remove();
        }
        this.activeTransfers.delete(transferId);

        // Update UI if no active transfers
        if (this.activeTransfers.size === 0) {
          this.transferStatus.style.display = 'block';
          this.transferTitle.textContent = "Ready to Transfer";
          if (this.clearTransfersBtn) this.clearTransfersBtn.style.display = 'none';
        }
      }

      this.showToast(`Transfer cancelled`);
      this.setPeerStatus(peerId, 'Ready to receive');
      return;
    }

    if (this.activeTransfers.size > 0) {
      this.showTransferSheet();
      this.transferTitle.textContent = "Transfers in Progress";
      if (this.clearTransfersBtn) this.clearTransfersBtn.style.display = 'block';
      this.transferStatus.style.display = 'none';
    }

    // Create or update transfer item
    let transferData = this.activeTransfers.get(transferId);
    let item;

    if (!transferData) {
      // Create new transfer item
      item = this.createTransferItem(peerId, direction, filename, totalSize);
      transferData = {
        peerId,
        filename,
        direction,
        progress: 0,
        totalSize,
        item,
        startTime: Date.now()
      };
      this.activeTransfers.set(transferId, transferData);
      this.transferContent.appendChild(item);
    } else {
      // Update existing transfer data
      transferData.progress = progress;
      transferData.totalSize = totalSize;
      item = transferData.item;
    }

    // Update the UI for this transfer
    this.updateTransferItemUI(item, peerId, direction, filename, progress, totalSize);
    transferData.progress = progress;
    this._scheduleAutoDismiss();
  }

  /**
   * Create a new transfer item element
   */
  _getFileIcon(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const icons = {
      mp4: '🎬', mov: '🎬', mkv: '🎬', webm: '🎬', avi: '🎬',
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', heic: '🖼️', svg: '🖼️',
      mp3: '🎵', wav: '🎵', ogg: '🎵', m4a: '🎵', flac: '🎵',
      pdf: '📄', doc: '📄', docx: '📄', txt: '📄', csv: '📄',
      zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
      apk: '📱', ipa: '📱', xapk: '📦',
    };
    return icons[ext] || '📎';
  }

  _formatBytes(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  createTransferItem(peerId, direction, filename, totalSize) {
    const transferId = `transfer-${peerId}-${direction}-${filename}`;
    const icon = this._getFileIcon(filename);

    const item = document.createElement('div');
    item.className = 'transfer-item';
    item.id = transferId;
    item.innerHTML = `
      <div class="transfer-header">
        <div class="transfer-icon">${icon}</div>
        <div class="transfer-info">
          <span class="transfer-name" title="${filename}">${this.truncateFilename(filename)}</span>
          <span class="transfer-meta">
            <span class="transfer-size">${this._formatBytes(totalSize)}</span>
          </span>
        </div>
        <div class="transfer-right">
          <span class="transfer-percent">0%</span>
          <span class="transfer-speed"></span>
        </div>
        <button class="btn-cancel-transfer" title="Cancel">✕</button>
      </div>
      <div class="transfer-progress-bar">
        <div class="transfer-progress-fill ${direction === 'receive' ? 'receive' : ''}"></div>
      </div>
      <div class="transfer-status-row ${direction}">
        <span class="dot"></span>
        <span class="status-text">${direction === 'send' ? 'Sending…' : 'Receiving…'}</span>
      </div>
    `;

    const cancelBtn = item.querySelector('.btn-cancel-transfer');
    cancelBtn.addEventListener('click', () => {
      if (this.onCancelTransfer) {
        this.onCancelTransfer(peerId, direction);
      }
      if (this.activeTransfers.has(transferId)) {
        const transferData = this.activeTransfers.get(transferId);
        transferData.progress = -1;
        this.updateProgress(peerId, filename, -1, transferData.totalSize, direction);
      }
    });

    return item;
  }

  /**
   * Update the UI of a transfer item
   */
  updateTransferItemUI(item, peerId, direction, filename, progress, totalSize) {
    const pFill = item.querySelector('.transfer-progress-fill');
    const pText = item.querySelector('.transfer-percent');
    const speedEl = item.querySelector('.transfer-speed');
    const statusText = item.querySelector('.status-text');
    const nameSpan = item.querySelector('.transfer-name');
    const transferId = `transfer-${peerId}-${direction}-${filename}`;
    const transferData = this.activeTransfers.get(transferId);

    // Update filename (with truncation for display)
    if (nameSpan) {
      nameSpan.title = filename;
      nameSpan.textContent = this.truncateFilename(filename);
    }

    // Calculate and show real-time speed
    if (transferData && speedEl) {
      const now = Date.now();
      const receivedBytes = (progress / 100) * totalSize;
      const elapsed = (now - (transferData.startTime || now)) / 1000;
      if (elapsed > 0.5 && progress > 1) {
        const mbps = receivedBytes / elapsed / 1024 / 1024;
        speedEl.textContent = mbps > 1 ? `${mbps.toFixed(1)} MB/s` : `${(mbps * 1024).toFixed(0)} KB/s`;
      }
      transferData.startTime = transferData.startTime || now;
    }

    // Update progress bar and text
    if (pFill && !pFill.classList.contains('done')) {
      pFill.style.width = `${progress}%`;
    }
    if (pText) pText.textContent = `${Math.round(progress)}%`;

    // Handle completion
    if (progress >= 100) {
      const cancelBtn = item.querySelector('.btn-cancel-transfer');
      if (cancelBtn) cancelBtn.remove();

      // Add done class to progress fill
      if (pFill) {
        pFill.classList.add('done');
        pFill.style.width = '100%';
      }

      // Update status and percent
      if (pText) {
        pText.textContent = direction === 'send' ? '✅ Sent' : '✅ Received';
      }
      if (speedEl) speedEl.textContent = '';
      if (statusText) {
        statusText.textContent = direction === 'send' ? 'Sent' : 'Received';
      }

      // Remove dot pulse on complete
      const dot = item.querySelector('.dot');
      if (dot) dot.style.animation = 'none';
    }
  }

  /**
   * Truncate filename for display in UI
   */
  truncateFilename(filename, maxLength = 20) {
    if (!filename) return '';
    if (filename.length <= maxLength) return filename;
    return filename.slice(0, maxLength - 1) + '…';
  }

  /**
   * Mark a transfer as complete (called when transfer finishes)
   */
  markTransferComplete(peerId, filename, direction) {
    // The updateProgress method with progress >= 100 will handle the UI update
    // We just need to ensure the final state is set
    const transferId = `transfer-${peerId}-${direction}-${filename}`;
    if (this.activeTransfers.has(transferId)) {
      const transferData = this.activeTransfers.get(transferId);
      // Update to 100% to trigger completion state
      this.updateProgress(peerId, filename, 100, transferData.totalSize, direction);
    }

    // No toast here: main.js announces completion with the peer's name, and
    // raising a second one meant every file arrived twice on screen.
    if (direction === 'receive') {
      this.setPeerStatus(peerId, 'Ready to receive');
    }
  }

  /**
   * Clear all completed transfers from the UI
   */
  clearCompletedTransfers() {
    this.activeTransfers.forEach((transferData, transferId) => {
      const item = transferData.item;
      if (item && item.parentNode) {
        // Check if transfer is complete (progress >= 100)
        if (transferData.progress >= 100) {
          item.remove();
          this.activeTransfers.delete(transferId);
        }
      }
    });

    // Update UI if no active transfers remain
    if (this.activeTransfers.size === 0) {
      this.transferStatus.style.display = 'block';
      this.transferTitle.textContent = "Ready to Transfer";
      if (this.clearTransfersBtn) this.clearTransfersBtn.style.display = 'none';
    }
  }
}