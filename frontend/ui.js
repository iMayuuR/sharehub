// ui.js

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
    this.activeTransfers = new Map();
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

    const handleSheet = document.querySelector('.sheet-handle');
    let startY = 0;
    handleSheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; });
    handleSheet.addEventListener('touchmove', e => {
       if (e.touches[0].clientY - startY > 50) this.hideTransferSheet();
    });

    if (this.clearTransfersBtn) {
      this.clearTransfersBtn.addEventListener('click', () => {
        const items = this.transferContent.querySelectorAll('.transfer-item');
        items.forEach(item => item.remove());
        this.transferStatus.style.display = 'block';
        this.transferTitle.textContent = "Ready to Transfer";
        this.clearTransfersBtn.style.display = 'none';
        setTimeout(() => this.hideTransferSheet(), 200);
      });
    }
  }

  // --- Toast Notification ---
  showToast(message, duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
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

  addPeer(peerId, name = 'Unknown Device', avatar = '💻') {
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
      <button class="btn-send">Send File</button>
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
        this.onPeerClick(peerId, e.dataTransfer.files[0]);
      }
    });

    const sendBtn = card.querySelector('.btn-send');
    sendBtn.addEventListener('click', () => {
      this.selectPeer(peerId);

      if (window.pendingShareFiles && window.pendingShareFiles.length > 0) {
        window.pendingShareFiles.forEach(f => {
          if (this.onPeerClick) this.onPeerClick(peerId, f);
        });
        window.pendingShareFiles = [];
        this.emptyState.innerHTML = `
          <div class="radar-animation">
            <div class="radar-dot" style="top: 20%; left: 60%; animation-delay: 0.5s;"></div>
            <div class="radar-dot" style="top: 70%; left: 30%; animation-delay: 1.2s;"></div>
            <div class="radar-dot" style="top: 40%; left: 20%; animation-delay: 0.8s;"></div>
          </div>
          <p>Searching for nearby ShareHub devices on your Wi-Fi...</p>
        `;
        if (this.peersContainer.querySelectorAll('.peer-card:not(.empty-state)').length > 0) {
          this.emptyState.style.display = 'none';
        }
        return;
      }

      this.fileInput.onchange = (e) => {
        if (e.target.files.length > 0 && this.onPeerClick) {
          this.onPeerClick(peerId, e.target.files[0]);
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

  updateProgress(peerId, filename, progress, totalSize, direction = 'send') {
    // progress = -1 means cancelled
    const transferId = `transfer-${direction}-${peerId}`;

    if (progress === -1) {
      // Transfer was cancelled by the other side
      const item = document.getElementById(transferId);
      if (item) {
        const pText = item.querySelector('.transfer-percent');
        const cancelBtn = item.querySelector('.btn-cancel-transfer');
        if (pText) pText.textContent = '❌ Cancelled';
        if (cancelBtn) cancelBtn.remove();
      }
      this.showToast(`Transfer cancelled`);
      this.setPeerStatus(peerId, 'Ready to receive');
      return;
    }

    this.showTransferSheet();
    this.transferTitle.textContent = "Transfers in Progress";
    if (this.clearTransfersBtn) this.clearTransfersBtn.style.display = 'block';

    let item = document.getElementById(transferId);
    const dirLabel = direction === 'send' ? '⬆ Sending' : '⬇ Receiving';

    if (!item) {
      this.transferStatus.style.display = 'none';
      item = document.createElement('div');
      item.className = 'transfer-item';
      item.id = transferId;
      item.innerHTML = `
        <div class="transfer-header">
          <span class="transfer-direction">${dirLabel}</span>
          <span class="transfer-name"></span>
          <span class="transfer-percent">0%</span>
          <button class="btn-cancel-transfer" title="Cancel">✕</button>
        </div>
        <div class="transfer-progress-bar">
          <div class="transfer-progress-fill ${direction === 'receive' ? 'receive' : ''}"></div>
        </div>
      `;
      
      item.querySelector('.transfer-name').textContent = filename;

      // Wire cancel button
      const cancelBtn = item.querySelector('.btn-cancel-transfer');
      cancelBtn.addEventListener('click', () => {
        if (this.onCancelTransfer) this.onCancelTransfer(peerId, direction);
        const pText = item.querySelector('.transfer-percent');
        if (pText) pText.textContent = '❌ Cancelled';
        cancelBtn.remove();
      });

      this.transferContent.appendChild(item);
    } else {
      item.querySelector('.transfer-name').textContent = filename;
    }

    const pFill = item.querySelector('.transfer-progress-fill');
    const pText = item.querySelector('.transfer-percent');

    pFill.style.width = `${progress}%`;
    pText.textContent = `${Math.round(progress)}%`;

    if (progress >= 100) {
      // Remove cancel button when done
      const cancelBtn = item.querySelector('.btn-cancel-transfer');
      if (cancelBtn) cancelBtn.remove();

      setTimeout(() => {
        if (item) {
          if (direction === 'send') {
            pText.textContent = 'Waiting for ACK...';
          } else {
            pText.innerHTML = '✅ Received!';
            pFill.classList.add('done');
          }
        }
      }, 300);
    }
  }

  markTransferComplete(peerId, filename, direction) {
    const transferId = `transfer-${direction}-${peerId}`;
    const item = document.getElementById(transferId);
    if (item) {
      const pText = item.querySelector('.transfer-percent');
      const pFill = item.querySelector('.transfer-progress-fill');
      if (direction === 'send') {
        pText.innerHTML = '✅ Sent!';
        pFill.classList.add('done');
      }
    }
    this.setPeerStatus(peerId, 'Ready to receive');
  }

  showTransferSheet() {
    this.transferSheet.classList.add('open');
    // Push footer above the sheet
    const footer = document.getElementById('appFooter');
    if (footer) footer.style.paddingBottom = '260px';
  }

  hideTransferSheet() {
    this.transferSheet.classList.remove('open');
    const footer = document.getElementById('appFooter');
    if (footer) footer.style.paddingBottom = '30px';
  }
}
