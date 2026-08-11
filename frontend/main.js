// main.js
import { getIdentity, saveIdentity, generateIdentity, identityForPeer } from './identity.js';
import { UIManager } from './ui.js';
import { SignalingClient } from './signaling.js';
import { WebRTCManager } from './webrtc.js';
import { OpticalUI } from './optical/ui.js';
import { ModeSwitch, PHOTON } from './mode-switch.js';
import { signalingOrigin } from './config.js';

let identity = getIdentity();
let signalingClient;
let webrtcManager;
let uiManager;
let opticalUI;
let modeSwitch;

window.myIdentityId = identity.id;

// Store metadata for discovered peers (Name and Avatar) mapping
const peerMetadata = new Map();

function init() {
  uiManager = new UIManager((peerId, fileOrFiles) => {
    if (!webrtcManager) return;
    const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    if (!files[0]) return;
    if (files.length > 1) {
      uiManager.showTransferSheet();
      uiManager.showToast(`Sending ${files.length} files…`);
      webrtcManager.sendFiles(peerId, files);
    } else {
      webrtcManager.sendFile(peerId, files[0]);
    }
  });

  uiManager.setIdentity(identity);

  // PhotonHub runs entirely offline — it never touches signalling or WebRTC.
  opticalUI = new OpticalUI({ onToast: (message) => uiManager.showToast(message) });

  modeSwitch = new ModeSwitch({
    onChange: (mode, reason) => {
      if (reason === 'offline') {
        uiManager.showToast('📴 No network — switched to PhotonHub');
      }
    },
    onNetworkChange: (online) => {
      opticalUI.refreshNote();
      if (online) {
        uiManager.showToast('🌐 Back online — Radar is live again');
        signalingClient?.connect();
      }
    },
  });
  window.shareHubBeam = (files) => opticalUI.beamFiles(files);

  document.getElementById('shareTrayBeam')?.addEventListener('click', () => {
    const pending = (window.pendingShareFiles || []).slice();
    if (!pending.length) return hideShareTray();
    window.pendingShareFiles = [];
    hideShareTray();
    opticalUI.beamFiles(pending);
  });
  document.getElementById('shareTrayDismiss')?.addEventListener('click', () => {
    window.pendingShareFiles = [];
    hideShareTray();
  });

  uiManager.saveProfileBtn.addEventListener('click', () => {
    identity.name = uiManager.editNameInput.value || identity.name;
    saveIdentity(identity);
    uiManager.setIdentity(identity);
    uiManager.profileModal.classList.remove('active');
    
    // Re-announce myself to all currently connected peers
    const announcement = { action: 'announce', name: identity.name, avatar: identity.avatar };
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

  const activePeers = new Set();

  // Setup Signaling
  signalingClient = new SignalingClient(
    identity.id,
    (joinedPeerId) => {
      activePeers.add(joinedPeerId);
      if (webrtcManager) webrtcManager.onPeerPresenceChange(activePeers.size > 0);

      // Peer joined - we only announce ourselves if we're in discoverable mode
      if (isDiscoverable) {
        signalingClient.sendSignal(joinedPeerId, { action: 'announce', name: identity.name, avatar: identity.avatar });
      }
      // Pre-connect WebRTC when peer joins so file transfer is instant
      webrtcManager.preConnect(joinedPeerId);
    },
    (leftPeerId) => {
      activePeers.delete(leftPeerId);
      if (webrtcManager) webrtcManager.onPeerPresenceChange(activePeers.size > 0);

      uiManager.removePeer(leftPeerId);
      peerMetadata.delete(leftPeerId);
    },
    (peersList) => {
      activePeers.clear();
      peersList.forEach(pId => {
        if (pId !== identity.id) activePeers.add(pId);
      });
      if (webrtcManager) webrtcManager.onPeerPresenceChange(activePeers.size > 0);

      // Current peers, announce myself to them only if discoverable
      if (isDiscoverable) {
        peersList.forEach(pId => {
           // Don't announce to ourselves
           if (pId !== identity.id) {
             signalingClient.sendSignal(pId, { action: 'announce', name: identity.name, avatar: identity.avatar });
           }
        });
      }
      // Add any peers we don't have metadata for yet (to show them in UI)
      peersList.forEach(pId => {
        if (pId !== identity.id && !peerMetadata.has(pId)) {
          // Not "Unknown Device": a name derived from the peer id, so it is
          // stable, friendly, and the same on both screens until their own
          // announcement arrives — or if it never does.
          const placeholder = identityForPeer(pId);
          uiManager.addPeer(pId, placeholder.name, placeholder.avatar);
          // Pre-connect to enable fast file transfer once they announce
          webrtcManager.preConnect(pId);
        }
      });
    },
    (fromPeerId, signal) => {
      if (signal.action === 'announce') {
         // Ignore our own announcements
         if (fromPeerId === identity.id) return;
         peerMetadata.set(fromPeerId, { name: signal.name, avatar: signal.avatar });
         uiManager.addPeer(fromPeerId, signal.name, signal.avatar);
         // Pre-connect WebRTC immediately so file transfer is instant when user taps Send
         webrtcManager.preConnect(fromPeerId);
         return;
      }
      // Backup ACK via signaling (when data channel ACK fails)
      if (signal.action === 'ack') {
         webrtcManager._completeSend(fromPeerId, signal.filename);
         return;
      }
      // Otherwise it's an RTC signal
      webrtcManager.handleSignal(fromPeerId, signal);
    },
    (fromPeerId, payload) => {
      webrtcManager.handleRelayData(fromPeerId, payload);
    }
  );

  // Track discoverability state
  let isDiscoverable = true;

  // Track if we're currently using relay for a peer (to warn about data usage)
  let relayWarningShown = new Set();

  // Setup WebRTC
  webrtcManager = new WebRTCManager(
    signalingClient,
    (peerId, filename, progress, totalSize, direction) => {
      uiManager.updateProgress(peerId, filename, progress, totalSize, direction);
    },
    (peerId, filename, direction) => {
      uiManager.markTransferComplete(peerId, filename, direction);
      const peerName = peerMetadata.get(peerId)?.name || 'Device';
      const q = webrtcManager.getQueueStatus(peerId);
      if (direction === 'send') {
        if (q.pending === 0) uiManager.showToast(`✅ Sent to ${peerName}`);
        if (q.pending > 0) {
          uiManager.setPeerStatus(peerId, `Sending… ${q.pending} file(s) remaining`);
        } else {
          uiManager.setPeerStatus(peerId, 'Ready to receive');
        }
      } else {
        uiManager.showToast(`📥 Received from ${peerName}: "${filename}"`);
        uiManager.setPeerStatus(peerId, 'Ready to receive');
      }
      // Notify WebRTC manager about transfer completion for wake lock management
      if (webrtcManager._decrementActiveTransfers) {
        webrtcManager._decrementActiveTransfers();
      }
    }
  );

  // Propagate initial peer presence to the WebRTC manager
  webrtcManager.onPeerPresenceChange(activePeers.size > 0);

  webrtcManager.onSendFailed = (peerId, filename, reason) => {
    uiManager.showToast(`⚠️ Send failed: ${reason}`);
    uiManager.setPeerStatus(peerId, 'Send failed — tap to retry');
  };

  // Transfer start notifications
  webrtcManager.onTransferStart = (peerId, filename, direction, meta) => {
    uiManager.showTransferSheet();
    const peerName = peerMetadata.get(peerId)?.name || 'Device';
    if (direction === 'send') {
      const q = webrtcManager.getQueueStatus(peerId);
      if (meta?.batchTotal > 1 || q.pending > 1) {
        const total = meta?.batchTotal || q.pending;
        uiManager.setPeerStatus(peerId, `Sending files (${total} queued)…`);
      } else {
        uiManager.setPeerStatus(peerId, `Sending "${filename}"…`);
        uiManager.showToast(`⬆ Sending "${filename}" to ${peerName}…`);
      }
    } else {
      uiManager.setPeerStatus(peerId, `Receiving "${filename}"…`);
    }
    // Notify WebRTC manager about transfer start for wake lock management
    if (webrtcManager._incrementActiveTransfers) {
      webrtcManager._incrementActiveTransfers();
    }
  };

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
      // Announcements to peers are handled via onPeerJoined/onPeersList callbacks

      // Auto-join room from URL (from QR code scan or shared link)
      const urlRoom = new URL(window.location.href).searchParams.get('room');
      if (urlRoom) {
        signalingClient.joinRoom(urlRoom.toUpperCase().trim());
      }
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

  // A VPN puts this device on a different public network from everyone in the
  // room, so the radar will never find them. Say so, and point at the fix.
  signalingClient.onRouting = (routedElsewhere) => {
    const empty = document.getElementById('emptyState');
    if (!routedElsewhere || !empty) return;
    if (uiManager.peersContainer.querySelectorAll('.peer-card:not(.empty-state)').length) return;
    const hint = empty.querySelector('.radar-vpn-hint') || document.createElement('p');
    hint.className = 'radar-vpn-hint';
    hint.textContent = 'Looks like a VPN or proxy is on. Nearby devices cannot be matched automatically — pair with a Room Code instead.';
    if (!hint.parentNode) empty.appendChild(hint);
  };

  // The discovery server being down is indistinguishable from an empty room if
  // all the user sees is a spinning radar. Name the problem, and point at the
  // route that needs no server at all.
  signalingClient.onUnreachable = () => {
    const empty = document.getElementById('emptyState');
    if (!empty || empty.querySelector('.radar-offline-hint')) return;
    if (uiManager.peersContainer.querySelectorAll('.peer-card:not(.empty-state)').length) return;

    const hint = document.createElement('div');
    hint.className = 'radar-vpn-hint radar-offline-hint';
    hint.innerHTML = '<strong>Cannot reach the discovery server.</strong> Radar needs it to find nearby devices. PhotonHub does not — it works with no network at all.';
    const jump = document.createElement('button');
    jump.className = 'btn btn-primary radar-offline-btn';
    jump.textContent = 'Use PhotonHub';
    jump.addEventListener('click', () => modeSwitch?.set(PHOTON, 'user'));
    hint.appendChild(jump);
    empty.appendChild(hint);
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

  signalingClient.connect();

  // Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Do not swallow this: a broken worker means no offline app, and
      // PhotonHub's whole point is working when nothing else does.
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[PWA] Service worker registration failed — offline support is off:', err);
      });
    });
  }

  // Keepalive ping — prevents the Render free tier sleeping (13 min interval)
  const ping = () => fetch(`${signalingOrigin()}/health`).catch(() => {});
  ping();
  setInterval(ping, 13 * 60 * 1000);

  // Mobile: reconnect WebSocket when app comes back to foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // App came to foreground - instant wake for network discovery
      if (!signalingClient.ws || signalingClient.ws.readyState > 1) {
        signalingClient.connect();
      }
      // Resume any background transfers that were paused
      webrtcManager.resumeTransfers();
    } else {
      // App went to background or screen off
      // Pause transfers to save battery but keep signaling alive for discovery
      webrtcManager.pauseTransfers();
    }
  });

  // Cancel support
  uiManager.onCancelTransfer = (peerId, direction) => {
    if (direction === 'send') {
      webrtcManager.cancelSend(peerId);
    } else {
      webrtcManager.cancelReceive(peerId);
    }
    uiManager.showToast('Transfer cancelled');
    uiManager.setPeerStatus(peerId, 'Ready to receive');
  };

  // PWA Install Prompt Logic
  let deferredPrompt;
  
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  
  if (!isStandalone) {
    const isIos = /ipad|iphone|ipod/.test(navigator.userAgent.toLowerCase()) && !window.MSStream;
    const bubble = document.getElementById('pwaInstallBubble');
    
    // iOS doesn't fire beforeinstallprompt. We show instructions instead.
    if (isIos && bubble && !localStorage.getItem('pwaInstallDeclined')) {
      const sub = document.getElementById('pwaBubbleSubtext');
      if (sub) sub.textContent = "Tap Share ➔ Add to Home Screen";
      setTimeout(() => showInstallBubble(bubble), 2000);
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent Chrome 67 and earlier from automatically showing the prompt
    e.preventDefault();
    deferredPrompt = e;
    
    // Show our custom UI
    const bubble = document.getElementById('pwaInstallBubble');
    if (bubble && !localStorage.getItem('pwaInstallDeclined')) {
      setTimeout(() => showInstallBubble(bubble), 1500);
    }
  });

  // PhotonHub only exists offline if the app is already on the device, so the
  // panel carries its own install prompt rather than relying on the bubble.
  const offlineReady = document.getElementById('offlineReady');
  const offlineReadyBtn = document.getElementById('offlineReadyBtn');
  const alreadyInstalled = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

  const refreshInstallNudge = () => {
    if (offlineReady) offlineReady.classList.toggle('active', !alreadyInstalled());
  };
  refreshInstallNudge();

  if (offlineReadyBtn) {
    offlineReadyBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        refreshInstallNudge();
        return;
      }
      const isIos = /ipad|iphone|ipod/.test(navigator.userAgent.toLowerCase()) && !window.MSStream;
      uiManager.showToast(
        isIos ? 'Tap Share ➔ Add to Home Screen' : 'Use your browser menu ➔ Install app'
      );
    });
  }

  const installBubble = document.getElementById('pwaInstallBubble');
  const dismissBtn = document.getElementById('pwaDismissBubble');

  if (installBubble) {
    installBubble.addEventListener('click', async (e) => {
      if (e.target === dismissBtn || dismissBtn.contains(e.target)) return;
      
      const isIos = /ipad|iphone|ipod/.test(navigator.userAgent.toLowerCase()) && !window.MSStream;
      if (isIos) return; // iOS has no programmatic trigger, instructions are visible

      hideInstallBubble(installBubble);
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
      hideInstallBubble(installBubble);
      localStorage.setItem('pwaInstallDeclined', 'true');
    });
  }

  window.addEventListener('appinstalled', () => {
    if (installBubble) hideInstallBubble(installBubble);
    if (offlineReady) offlineReady.classList.remove('active');
    deferredPrompt = null;
  });
}

window.pendingShareFiles = [];

function checkPendingOSFiles() {
  // Handle case when SW wasn't installed yet (first-time gallery share)
  if (window.location.search.includes('shared=pending')) {
    window.history.replaceState({}, document.title, '/');
    // The service worker was not installed in time to catch the POST. It is
    // now, so the next share will land — say so where the user can see it.
    showShareTray({
      icon: '🔄',
      title: 'Almost there',
      sub: 'ShareHub is ready now. Share those files again from your gallery and they will land here.',
      canBeam: false,
    });
    return;
  }

  // Check URL for ?shared=true (SW handled the POST)
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

/**
 * Shows above the mode tabs, so it is there in both Radar and PhotonHub. The
 * old version rewrote the radar's empty state, which meant a user on the
 * PhotonHub tab saw nothing at all after sharing from their gallery — and the
 * radar markup never came back.
 */
/** The bubble floats over the bottom-right, so the footer is told to leave room. */
function showInstallBubble(bubble) {
  bubble.style.display = 'flex';
  document.body.classList.add('has-install-bubble');
}

function hideInstallBubble(bubble) {
  bubble.style.display = 'none';
  document.body.classList.remove('has-install-bubble');
}

function showShareTray({ icon, title, sub, canBeam }) {
  const tray = document.getElementById('shareTray');
  if (!tray) return;
  document.getElementById('shareTrayIcon').textContent = icon;
  document.getElementById('shareTrayTitle').textContent = title;
  document.getElementById('shareTraySub').textContent = sub;
  document.getElementById('shareTrayBeam').style.display = canBeam ? '' : 'none';
  tray.classList.add('active');
}

function hideShareTray() {
  document.getElementById('shareTray')?.classList.remove('active');
}

function showPendingShareUI() {
  const count = window.pendingShareFiles.length;
  showShareTray({
    icon: '📦',
    title: `${count} file${count === 1 ? '' : 's'} ready to send`,
    sub: 'Pick a device on Radar, or beam them straight across with PhotonHub.',
    canBeam: true,
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const year = document.getElementById('currentYear');
  if (year) year.textContent = String(new Date().getFullYear());

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
