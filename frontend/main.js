// main.js
import { getIdentity, saveIdentity, generateIdentity } from './identity.js';
import { UIManager } from './ui.js';
import { SignalingClient } from './signaling.js';
import { WebRTCManager } from './webrtc.js';

let identity = getIdentity();
let signalingClient;
let webrtcManager;
let uiManager;

window.myIdentityId = identity.id;

// Store metadata for discovered peers (Name and Avatar)
const peerMetadata = new Map();

function init() {
  uiManager = new UIManager(
    (peerId, file) => {
      webrtcManager.sendFile(peerId, file);
    },
    (roomCode) => {
      signalingClient.joinRoom(roomCode);
    }
  );
  
  uiManager.setIdentity(identity);

  // Handle Profile Edits (via custom event from UI)
  window.addEventListener('profileUpdate', (e) => {
    const { name, avatar } = e.detail;
    identity.name = name;
    identity.avatar = avatar;
    saveIdentity(identity);
    uiManager.setIdentity(identity);
    
    // Re-announce myself to all currently connected peers
    const announcement = { action: 'announce', name: identity.name, avatar: identity.avatar };
    for (const pId of peerMetadata.keys()) {
      signalingClient.sendSignal(pId, announcement);
    }
  });

  // Randomize Avatar
  if (uiManager.randomizeAvatarBtn) {
    uiManager.randomizeAvatarBtn.addEventListener('click', () => {
      const newId = generateIdentity();
      uiManager.editNameInput.value = newId.name;
      uiManager.editAvatarPreview.textContent = newId.avatar;
    });
  }

  // Setup Signaling
  signalingClient = new SignalingClient(
    identity.id,
    (joinedPeerId) => {
      signalingClient.sendSignal(joinedPeerId, { action: 'announce', name: identity.name, avatar: identity.avatar });
    },
    (leftPeerId) => {
      uiManager.removePeer(leftPeerId);
      peerMetadata.delete(leftPeerId);
    },
    (peersList) => {
      peersList.forEach(pId => {
         signalingClient.sendSignal(pId, { action: 'announce', name: identity.name, avatar: identity.avatar });
      });
    },
    (fromPeerId, signal) => {
      if (signal.action === 'announce') {
         peerMetadata.set(fromPeerId, { name: signal.name, avatar: signal.avatar });
         uiManager.addPeer(fromPeerId, signal.name, signal.avatar);
         return;
      }
      webrtcManager.handleSignal(fromPeerId, signal);
    },
    (fromPeerId, payload) => {
      webrtcManager.handleRelayData(fromPeerId, payload);
    }
  );

  // Setup WebRTC
  webrtcManager = new WebRTCManager(
    signalingClient,
    (peerId, filename, progress, totalSize, status) => {
      uiManager.updateProgress(peerId, filename, progress, totalSize, status);
    },
    (peerId, filename) => {
      // File transfer complete
    }
  );

  // Connection status feedback on radar dot
  const radarDot = document.querySelector('.section-title span');
  const subtitle = document.querySelector('.section-subtitle');
  signalingClient.onConnectionChange = (state) => {
    if (!radarDot) return;
    if (state === 'connected') {
      radarDot.style.background = '#00ff6a';
      radarDot.style.boxShadow = '0 0 8px rgba(0,255,106,0.6)';
      if (subtitle) subtitle.textContent = 'Connected. Devices on your network appearing automatically.';
    } else if (state === 'connecting') {
      radarDot.style.background = '#ffaa00';
      radarDot.style.boxShadow = '0 0 8px rgba(255,170,0,0.6)';
    } else {
      radarDot.style.background = '#ff3333';
      radarDot.style.boxShadow = '0 0 8px rgba(255,51,51,0.6)';
    }
  };

  signalingClient.onRoomJoined = (roomCode) => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('room') || url.searchParams.has('roomId')) {
      url.searchParams.delete('room');
      url.searchParams.delete('roomId');
      window.history.replaceState({}, document.title, url.pathname);
    }
  };

  // Discovery: Fetch Public IP for better grouping
  fetch('https://api.ipify.org?format=json')
    .then(res => res.json())
    .then(data => {
      signalingClient.connect(null, data.ip);
    })
    .catch(() => {
      signalingClient.connect();
    });

  // Auto-join room from URL
  const urlRoom = new URL(window.location.href).searchParams.get('room');
  if (urlRoom) {
    const waitAndJoin = setInterval(() => {
      if (signalingClient.ws && signalingClient.ws.readyState === WebSocket.OPEN) {
        clearInterval(waitAndJoin);
        signalingClient.joinRoom(urlRoom.toUpperCase().trim());
      }
    }, 200);
  }

  // Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // Keepalive ping for Render
  const signalingUrl = import.meta.env.VITE_SIGNALING_URL;
  if (signalingUrl) {
    const ping = () => fetch(`${signalingUrl}/health`).catch(() => {});
    ping();
    setInterval(ping, 13 * 60 * 1000);
  }
}

function checkPendingOSFiles() {
  if ('indexedDB' in window) {
    const req = indexedDB.open('ShareHubDB', 1);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sharedFiles')) return;
      const tx = db.transaction('sharedFiles', 'readwrite');
      const store = tx.objectStore('sharedFiles');
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        window.pendingShareFiles = getAllReq.result || [];
        if (window.pendingShareFiles.length > 0) {
           // Display pending files in UI
        }
        window.history.replaceState({}, document.title, "/");
        store.clear();
      };
    };
  }
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    init();
    checkPendingOSFiles();
  } catch (e) {
    console.error("Initialization failed", e);
  } finally {
    // Definitive splash removal
    const checkStyles = setInterval(() => {
      const bgDark = getComputedStyle(document.documentElement).getPropertyValue('--bg-dark');
      if (bgDark && bgDark.trim() !== '') {
        clearInterval(checkStyles);
        document.fonts.ready.then(() => {
          const splash = document.getElementById('app-splash');
          const fouc = document.getElementById('fouc-shield');
          if (splash) {
            splash.style.opacity = '0';
            setTimeout(() => splash.remove(), 500);
          }
          if (fouc) fouc.remove();
        });
      }
    }, 100);
  }
});
