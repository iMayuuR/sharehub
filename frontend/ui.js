// ui.js
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
    
    this.qrCodeBtn = document.getElementById('qrCodeBtn'); // Note: we removed this from HTML, so it might be null
    this.mainReceiveBtn = document.getElementById('mainReceiveBtn');
    this.qrModal = document.getElementById('qrModal');
    this.closeQrBtn = document.getElementById('closeQrBtn');
    this.qrCodeContainer = document.getElementById('qrCodeContainer');

    this.onPeerClick = onPeerClick;
    this.activeTransfers = new Map();

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
      if (e.key === 'Enter') {
        e.preventDefault();
        this.saveProfileBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeProfileBtn.click();
      }
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
    
    const showQrModal = () => {
      const pairUrl = `${window.location.origin}/?roomId=${window.myIdentityId || 'local'}`;
      this.qrCodeContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(pairUrl)}" alt="QR Code" style="display:block; border-radius: 8px;" />`;
      this.qrModal.classList.add('active');
    };
    
    if (this.qrCodeBtn) this.qrCodeBtn.addEventListener('click', showQrModal);
    if (this.mainReceiveBtn) this.mainReceiveBtn.addEventListener('click', showQrModal);
    
    if (this.closeQrBtn) {
      this.closeQrBtn.addEventListener('click', () => {
        this.qrModal.classList.remove('active');
        this.qrCodeContainer.innerHTML = '<span style="color: var(--text-secondary);">Generating...</span>';
      });
      setupOverlayClose(this.qrModal, () => this.closeQrBtn.click());
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
      <div class="avatar">${avatar}</div>
      <div class="peer-info">
        <h3>${name}</h3>
        <p>Ready to receive</p>
      </div>
      <button class="btn-send">Send File</button>
    `;

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', (e) => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0 && this.onPeerClick) {
        this.onPeerClick(peerId, e.dataTransfer.files[0]);
      }
    });

    const sendBtn = card.querySelector('.btn-send');
    sendBtn.addEventListener('click', () => {
      // Check for pending shared files from OS
      if (window.pendingShareFiles && window.pendingShareFiles.length > 0) {
        window.pendingShareFiles.forEach(f => {
          if (this.onPeerClick) this.onPeerClick(peerId, f);
        });
        window.pendingShareFiles = [];
        
        // Reset empty state UI
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
    if (card) {
      this.peersContainer.removeChild(card);
    }
    
    if (this.peersContainer.querySelectorAll('.peer-card:not(.empty-state)').length === 0) {
      this.emptyState.style.display = 'flex';
    }
  }

  updateProgress(peerId, filename, progress, totalSize) {
    this.showTransferSheet();
    this.transferTitle.textContent = "Transfers in Progress";
    if (this.clearTransfersBtn) this.clearTransfersBtn.style.display = 'block';
    
    let item = document.getElementById(`transfer-${peerId}`);
    if (!item) {
      this.transferStatus.style.display = 'none';
      item = document.createElement('div');
      item.className = 'transfer-item';
      item.id = `transfer-${peerId}`;
      item.innerHTML = `
        <div class="transfer-header">
          <span class="transfer-name">${filename}</span>
          <span class="transfer-percent">0%</span>
        </div>
        <div class="transfer-progress-bar">
          <div class="transfer-progress-fill"></div>
        </div>
      `;
      this.transferContent.appendChild(item);
    } else {
      item.querySelector('.transfer-name').textContent = filename;
    }

    const pFill = item.querySelector('.transfer-progress-fill');
    const pText = item.querySelector('.transfer-percent');
    
    pFill.style.width = `${progress}%`;
    pText.textContent = `${Math.round(progress)}%`;

    if (progress >= 100) {
      setTimeout(() => {
        if (item) {
          item.querySelector('.transfer-percent').textContent = 'Done!';
        }
      }, 500);
    }
  }

  showTransferSheet() {
    this.transferSheet.classList.add('open');
  }

  hideTransferSheet() {
    this.transferSheet.classList.remove('open');
  }
}
