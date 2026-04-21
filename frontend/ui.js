// ui.js
export class UIManager {
  constructor(onPeerClick, onJoinRoom) {
    this.onPeerClick = onPeerClick;
    this.onJoinRoom = onJoinRoom;
    
    // UI Elements
    this.peersContainer = document.getElementById('peersContainer');
    this.emptyState = document.getElementById('emptyState');
    this.pairModal = document.getElementById('pairModal');
    this.openPairBtns = document.querySelectorAll('#openPairBtn, #landingOpenPairBtn');
    this.closePairBtn = document.getElementById('closePairBtn');
    this.myRoomCode = document.getElementById('myRoomCode');
    this.qrCodeContainer = document.getElementById('qrCodeContainer');
    this.copyRoomCodeBtn = document.getElementById('copyRoomCodeBtn');
    this.joinRoomInput = document.getElementById('joinRoomInput');
    this.joinRoomBtn = document.getElementById('joinRoomBtn');
    
    this.myName = document.getElementById('myNameDisplay');
    this.myAvatar = document.getElementById('myAvatarDisplay');
    this.editProfileBtn = document.getElementById('editProfileBtn');
    this.profileModal = document.getElementById('profileModal');
    this.closeProfileBtn = document.getElementById('closeProfileBtn');
    this.saveProfileBtn = document.getElementById('saveProfileBtn');
    this.randomizeAvatarBtn = document.getElementById('randomizeAvatarBtn');
    this.editNameInput = document.getElementById('editNameInput');
    this.editAvatarPreview = document.getElementById('editAvatarPreview');
    this.avatarOptions = document.querySelectorAll('.avatar-option');
    this.fileInput = document.getElementById('fileInput');

    this.transferSheet = document.getElementById('transferSheet');
    this.transferContent = document.getElementById('transferContent');
    this.transferStatus = document.getElementById('transferStatus');
    this.transferTitle = document.getElementById('transferTitle');
    this.clearTransfersBtn = document.getElementById('clearTransfersBtn');
    
    this.toastContainer = document.getElementById('toastContainer');
    
    this.roomCode = null;
    this.init();
  }

  init() {
    // Open Pair Modal
    const openPair = () => {
      this.pairModal.style.display = 'flex';
      this.pairModal.style.opacity = '0';
      setTimeout(() => { this.pairModal.style.opacity = '1'; }, 10);
    };
    this.openPairBtns.forEach(btn => btn.addEventListener('click', openPair));

    // Close Pair Modal
    const closePair = () => {
      this.pairModal.style.opacity = '0';
      setTimeout(() => { this.pairModal.style.display = 'none'; }, 300);
    };
    this.closePairBtn.addEventListener('click', closePair);

    // Profile Edit
    this.editProfileBtn.addEventListener('click', () => {
      this.profileModal.style.display = 'flex';
    });
    this.closeProfileBtn.addEventListener('click', () => {
      this.profileModal.style.display = 'none';
    });
    
    this.saveProfileBtn.addEventListener('click', () => {
      const newName = this.editNameInput.value.trim();
      const newAvatar = this.editAvatarPreview.textContent;
      if (newName) {
        window.dispatchEvent(new CustomEvent('profileUpdate', { detail: { name: newName, avatar: newAvatar } }));
        this.profileModal.style.display = 'none';
      }
    });

    if (this.avatarOptions.length > 0) {
      this.avatarOptions.forEach(opt => {
        opt.addEventListener('click', () => {
          this.editAvatarPreview.textContent = opt.textContent;
        });
      });
    }

    // Copy room code
    if (this.copyRoomCodeBtn) {
      this.copyRoomCodeBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.roomCode).then(() => {
          this.copyRoomCodeBtn.textContent = '✅';
          setTimeout(() => this.copyRoomCodeBtn.textContent = '📋', 2000);
        });
      });
    }

    // Join room input
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

    // Auto-uppercase input
    if (this.joinRoomInput) {
      this.joinRoomInput.addEventListener('input', () => {
        this.joinRoomInput.value = this.joinRoomInput.value.toUpperCase();
      });
    }

    // Transfer sheet drag-to-dismiss
    const handleSheet = document.querySelector('.sheet-handle');
    if (handleSheet) {
      let startY = 0;
      handleSheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; });
      handleSheet.addEventListener('touchmove', e => {
         if (e.touches[0].clientY - startY > 50) this.hideTransferSheet();
      });
    }

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

  showToast(message) {
    if (!this.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    this.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-20px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
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

    // Visual selection logic
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-send')) return;
      document.querySelectorAll('.peer-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
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
        this.showToast(`Sending to ${name}...`);
        this.onPeerClick(peerId, e.dataTransfer.files[0]);
      }
    });

    const sendBtn = card.querySelector('.btn-send');
    sendBtn.addEventListener('click', () => {
      // Check for pending shared files from OS
      if (window.pendingShareFiles && window.pendingShareFiles.length > 0) {
        window.pendingShareFiles.forEach(f => {
          if (this.onPeerClick) {
            this.showToast(`Sending to ${name}...`);
            this.onPeerClick(peerId, f);
          }
        });
        window.pendingShareFiles = [];
        return;
      }

      this.fileInput.onchange = (e) => {
        if (e.target.files.length > 0 && this.onPeerClick) {
          this.showToast(`Sending to ${name}...`);
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

  updateProgress(peerId, filename, progress, totalSize, status = 'transferring') {
    this.showTransferSheet();
    this.transferTitle.textContent = "Transfers in Progress";
    if (this.clearTransfersBtn) this.clearTransfersBtn.style.display = 'block';

    let itemStr = `transfer-${peerId}-${filename}`.replace(/[^a-zA-Z0-9-]/g, '');
    let item = document.getElementById(itemStr); 
    if (!item) {
      this.transferStatus.style.display = 'none';
      item = document.createElement('div');
      item.className = 'transfer-item';
      item.id = itemStr;
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

      if (status === 'receiving') {
        this.showToast(`Receiving ${filename}...`);
      }
    }

    const pFill = item.querySelector('.transfer-progress-fill');
    const pText = item.querySelector('.transfer-percent');

    pFill.style.width = `${progress}%`;
    pText.textContent = `${Math.round(progress)}%`;

    if (status === 'completed' || progress >= 100) {
      const waitTime = status === 'completed' ? 0 : 1000;
      setTimeout(() => {
        if (item) {
          pText.innerHTML = '<span class="transfer-status-success">✅ Done</span>';
          if (status === 'completed') {
             this.showToast(`Successfully sent ${filename}!`);
          }
        }
      }, waitTime);
    }
  }

  showTransferSheet() {
    this.transferSheet.classList.add('open');
  }

  hideTransferSheet() {
    this.transferSheet.classList.remove('open');
  }

  updatePairInfo(roomCode, qrUrl) {
    this.roomCode = roomCode;
    this.myRoomCode.textContent = roomCode;
    
    // Clear generating text
    this.qrCodeContainer.innerHTML = '';
    
    // Fallback: use an image API if library not loaded
    const qrImg = document.createElement('img');
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrUrl)}&bgcolor=0a0a0a&color=ffffff`;
    this.qrCodeContainer.appendChild(qrImg);
  }
}
