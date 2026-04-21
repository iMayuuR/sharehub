// main.js
import { getIdentity, saveIdentity, generateIdentity } from './identity.js';
import { UIManager } from './ui.js';
import { SignalingClient } from './signaling.js';
import { WebRTCManager } from './webrtc.js';

let identity = getIdentity();
let signalingClient;
let webrtcManager;
let uiManager;
let myAdName = '';

window.myIdentityId = identity.id;

// Store metadata for discovered peers (Name and Avatar) mapping
const peerMetadata = new Map();

function init() {
  uiManager = new UIManager((peerId, file) => {
    // When user tries to send a file
    webrtcManager.sendFile(peerId, file);
  });
  
  uiManager.setIdentity(identity);
  myAdName = JSON.stringify({ name: identity.name, avatar: identity.avatar, action: 'announce' });

  // Handle Profile Edits
  uiManager.saveProfileBtn.addEventListener('click', () => {
    identity.name = uiManager.editNameInput.value || identity.name;
    saveIdentity(identity);
    uiManager.setIdentity(identity);
    uiManager.profileModal.classList.remove('active');
    
    // Re-announce myself to all currently connected peers
    const announcement = { action: 'announce', name: identity.name, avatar: identity.avatar };
    myAdName = JSON.stringify(announcement);
    for (const pId of peerMetadata.keys()) {
      signalingClient.sendSignal(pId, announcement);
    }
  });

  uiManager.randomizeAvatarBtn.addEventListener('click', () => {
    const newId = generateIdentity();
    uiManager.editNameInput.value = newId.name;
    uiManager.editAvatarPreview.textContent = newId.avatar;
    identity.avatar = newId.avatar;
  });

  // Setup Signaling
  signalingClient = new SignalingClient(
    identity.id,
    (joinedPeerId) => {
      // Peer joined, maybe wait for their announce signal or we can initiate a connection to get info.
      // But actually, we need a way to know their name!
      // Here we cheat a little by using WebRTC data channel or signaling channel to send names.
      // We'll broadcast our name back over signaling if someone joins.
      signalingClient.sendSignal(joinedPeerId, { action: 'announce', name: identity.name, avatar: identity.avatar });
    },
    (leftPeerId) => {
      uiManager.removePeer(leftPeerId);
      peerMetadata.delete(leftPeerId);
    },
    (peersList) => {
      // Current peers, announce myself to them
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
      // Otherwise it's an RTC signal
      webrtcManager.handleSignal(fromPeerId, signal);
    },
    (fromPeerId, payload) => {
      webrtcManager.handleRelayData(fromPeerId, payload);
    }
  );

  // Setup WebRTC
  webrtcManager = new WebRTCManager(
    signalingClient,
    (peerId, filename, progress, totalSize) => {
      uiManager.updateProgress(peerId, filename, progress, totalSize);
    },
    (peerId, filename) => {
      // File transfer complete
    }
  );

  // Wire up Room Code joining
  uiManager.onJoinRoom = (roomCode) => {
    signalingClient.joinRoom(roomCode);
  };

  // Connection status feedback on radar dot
  const radarDot = document.querySelector('.section-title span');
  const subtitle = document.querySelector('.section-subtitle');
  signalingClient.onConnectionChange = (state) => {
    if (!radarDot) return;
    if (state === 'connected') {
      radarDot.style.background = '#00ff6a';
      radarDot.style.boxShadow = '0 0 8px rgba(0,255,106,0.6)';
      if (subtitle) subtitle.textContent = 'Connected to server. Devices on your network appear automatically. Use a Room Code to connect across any network.';
    } else if (state === 'connecting') {
      radarDot.style.background = '#ffaa00';
      radarDot.style.boxShadow = '0 0 8px rgba(255,170,0,0.6)';
      if (subtitle) subtitle.textContent = 'Connecting to server...';
    } else {
      radarDot.style.background = '#ff3333';
      radarDot.style.boxShadow = '0 0 8px rgba(255,51,51,0.6)';
      if (subtitle) subtitle.textContent = 'Connection lost. Retrying...';
    }
  };

  signalingClient.onRoomJoined = (roomCode) => {
    // Clean up URL if it had ?room= param
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
      // Fallback to server-side only if fetch fails
      signalingClient.connect();
    });

  // Auto-join room from URL (from QR code scan or shared link)
  const urlRoom = new URL(window.location.href).searchParams.get('room');
  if (urlRoom) {
    // Wait for WebSocket to open, then join the room
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

  // Keepalive ping — prevents Render free tier from sleeping (13 min interval)
  const signalingUrl = import.meta.env.VITE_SIGNALING_URL;
  if (signalingUrl) {
    const ping = () => fetch(`${signalingUrl}/health`).catch(() => {});
    ping(); // Wake it up immediately on page load
    setInterval(ping, 13 * 60 * 1000); // Then every 13 minutes
  }

  // PWA Install Prompt Logic
  let deferredPrompt;
  
  // 1. Check if already installed
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  
  if (!isStandalone) {
    const isIos = /ipad|iphone|ipod/.test(navigator.userAgent.toLowerCase()) && !window.MSStream;
    const bubble = document.getElementById('pwaInstallBubble');
    
    // iOS doesn't fire beforeinstallprompt. We show instructions instead.
    if (isIos && bubble && !localStorage.getItem('pwaInstallDeclined')) {
      const sub = document.getElementById('pwaBubbleSubtext');
      if (sub) sub.textContent = "Tap Share ➔ Add to Home Screen";
      setTimeout(() => bubble.style.display = 'flex', 2000);
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent Chrome 67 and earlier from automatically showing the prompt
    e.preventDefault();
    deferredPrompt = e;
    
    // Show our custom UI
    const bubble = document.getElementById('pwaInstallBubble');
    if (bubble && !localStorage.getItem('pwaInstallDeclined')) {
      setTimeout(() => bubble.style.display = 'flex', 1500); // Popup slightly faster
    }
  });

  const installBubble = document.getElementById('pwaInstallBubble');
  const dismissBtn = document.getElementById('pwaDismissBubble');

  if (installBubble) {
    installBubble.addEventListener('click', async (e) => {
      if (e.target === dismissBtn || dismissBtn.contains(e.target)) return;
      
      const isIos = /ipad|iphone|ipod/.test(navigator.userAgent.toLowerCase()) && !window.MSStream;
      if (isIos) return; // iOS has no programmatic trigger, instructions are visible

      installBubble.style.display = 'none';
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;

        deferredPrompt = null;
      }
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      installBubble.style.display = 'none';
      localStorage.setItem('pwaInstallDeclined', 'true');
    });
  }

  window.addEventListener('appinstalled', () => {
    if (installBubble) installBubble.style.display = 'none';
    deferredPrompt = null;

  });
}

window.pendingShareFiles = [];

function checkPendingOSFiles() {
  // Check URL for ?shared=true
  if (window.location.search.includes('shared=true')) {
    const request = indexedDB.open('ShareHubDB', 1);
    request.onsuccess = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('sharedFiles')) return;
      const tx = db.transaction('sharedFiles', 'readwrite');
      const store = tx.objectStore('sharedFiles');
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        window.pendingShareFiles = getAllReq.result || [];
        if (window.pendingShareFiles.length > 0) showPendingShareUI();
        window.history.replaceState({}, document.title, "/");
        store.clear();
      };
    };
  }
  
  // iOS Fallback: Paste Event
  window.addEventListener('paste', (e) => {
    if (e.clipboardData.files.length > 0) {
      window.pendingShareFiles = Array.from(e.clipboardData.files);
      showPendingShareUI();
    }
  });
}

function showPendingShareUI() {
  const emptyState = document.getElementById('emptyState');
  if(emptyState) {
    emptyState.innerHTML = `
      <div class="avatar" style="font-size:3rem; margin-bottom: 10px; background: transparent; box-shadow: none;">📦</div>
      <p style="font-weight: bold; color: var(--neon-cyan)">${window.pendingShareFiles.length} file(s) ready to send!</p>
      <p style="font-size: 0.9rem;">Tap 'Send' on any device to share.</p>
    `;
    emptyState.style.display = 'flex';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  init();
  checkPendingOSFiles();
  
  // Dynamically poll for style.css to be definitively loaded
  const checkStyles = setInterval(() => {
    // We check if --bg-dark exists in the computed stylesheets applied
    const bgDark = getComputedStyle(document.documentElement).getPropertyValue('--bg-dark');
    if (bgDark && bgDark.trim() !== '') {
      clearInterval(checkStyles);
      
      // Wait for fonts to avoid layout shifting (jumping up/down when custom font replaces system font)
      document.fonts.ready.then(() => {
        // Wipe the FOUC shield!
        const shield = document.getElementById('fouc-shield');
        if (shield) shield.remove();
        
        // Animate out splash securely
        const splash = document.getElementById('app-splash');
        if (splash) {
          splash.style.opacity = '0';
          setTimeout(() => splash.remove(), 400); // Wait for transition
        }
      });
    }
  }, 50); // Check extremely fast every 50ms
});
