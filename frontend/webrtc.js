// webrtc.js - Enhanced logging for debugging

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
const RELAY_CHUNK_SIZE = 256 * 1024; // 256KB

// Extension recovery for files missing extensions (Android gallery)
const MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/heic': '.heic', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'video/x-matroska': '.mkv', 'video/3gpp': '.3gp',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  'application/pdf': '.pdf', 'application/zip': '.zip',
  'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json',
};

function ensureExtension(name, mimeType) {
  if (!name) name = 'shared_file';
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0 && lastDot > name.length - 8) return name;
  const ext = MIME_TO_EXT[mimeType] || '';
  return ext ? name + ext : name;
}

export class WebRTCManager {
  constructor(signalingClient, onProgress, onFileComplete) {
    this.signalingClient = signalingClient;
    this.myPeerId = signalingClient.peerId;
    this.onProgress = onProgress;
    this.onFileComplete = onFileComplete;
    this.onTransferStart = null;
    this.connections = new Map();
    this.channels = new Map();
    this.incomingFiles = new Map();
    this.activeSends = new Map();
    this._makingOffer = new Map(); // Track offer creation per peer
    this._pendingCandidates = new Map(); // Buffer candidates until remote desc is set
    this._relayWarningShown = new Set(); // Track which peers we've warned about relay usage
    this._connectionTimeouts = new Map(); // Track connection timeouts per peer
    this.activeTransferCount = 0; // Track number of active transfers for wake lock
    this.wakeLock = null; // Wake Lock handle
  }

  // "Polite peer" pattern: The peer with the SMALLER ID is "polite"
  // and will yield when both sides send offers simultaneously (glare)
  _isPolite(peerId) {
    return this.myPeerId < peerId;
  }

  createConnection(peerId) {
    if (this.connections.has(peerId)) {
      const existing = this.connections.get(peerId);
      if (existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
        return existing;
      }
      this.connections.delete(peerId);
      this.channels.delete(peerId);
    }

    const rtcConfig = {
      iceServers: [
        // Primary STUN servers - Google
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },

        // Secondary STUN servers - Firefox
        { urls: 'stun:stun.services.mozilla.com' },

        // Other reliable STUN servers
        { urls: 'stun:stun.stunprotocol.org' },
        { urls: 'stun:stun.voiparound.com' },
        { urls: 'stun:stun.voipbuster.com' },
        { urls: 'stun:stun.voipstunt.com' },
        { urls: 'stun:stun.ideasip.com' },
        { urls: 'stun:stun.iptel.org' },
        { urls: 'stun:stun.rixtelecom.se' },
        { urls: 'stun:stun.ekiga.net' },
        { urls: 'stun:stun.freeswitch.org' },

        // STUN servers with IPv6 support
        { urls: 'stun:[2a01:4f8:c2c:123f::1]:3478' }
      ],
      // TURN servers for relay fallback when direct connection fails
      // Using multiple TURN providers for better reliability
      ...([
        // openrelay.metered.ca (free tier)
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:80?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]),
      iceCandidatePoolSize: 20,
      // ICE Transport Policy - allow both relay and host candidates
      iceTransportPolicy: 'all',
      // Bundle policy to reduce number of ICE checks
      bundlePolicy: 'max-bundle',
      // Rtcp mux policy
      rtcpMuxPolicy: 'require',
      // Enable ICE restart for better connection recovery
      iceRestartTimeout: 30000,
      // Reduce ICE timeout for faster failure detection
      iceConnectionTimeout: 20000,
      // Enable IPv6 candidates
      // Note: iceTransportPolicy: 'all' already enables IPv6 when available
    };

    const pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.sendSignal(peerId, { candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.connections.delete(peerId);
        this.channels.delete(peerId);
      }
    };

    pc.ondatachannel = (event) => {
      this.setupChannel(peerId, event.channel);
    };

    pc.onnegotiationneeded = async () => {
      try {
        this._makingOffer.set(peerId, true);
        await pc.setLocalDescription();
        this.signalingClient.sendSignal(peerId, { sdp: pc.localDescription });
      } catch (err) {
        console.error('WebRTC signal handling error:', err);
      } finally {
        this._makingOffer.set(peerId, false);
      }
    };

    this.connections.set(peerId, pc);
    return pc;
  }

  // Pre-connect: Only the "impolite" peer (larger ID) initiates
  // This prevents glare (both sides sending offers simultaneously)
  preConnect(peerId) {
    if (this.channels.has(peerId)) return; // Already have a channel

    const pc = this.createConnection(peerId);

    // Only the impolite peer (larger ID) creates the data channel
    // This triggers onnegotiationneeded → sends offer
    if (!this._isPolite(peerId)) {
      const channel = pc.createDataChannel('fileTransfer', {
        ordered: true,
        maxPacketLifeTime: 500, // 0.5 seconds
        negotiated: false
      });
      this.setupChannel(peerId, channel);
    }
  }

  setupChannel(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    if (typeof channel.bufferedAmountLowThreshold !== 'undefined') {
      channel.bufferedAmountLowThreshold = 16 * 1024 * 1024;
    }
    this.channels.set(peerId, channel);

    channel.onopen = () => {};
    channel.onclose = () => {
      this.channels.delete(peerId);
    };
    channel.onmessage = (event) => {
      this.handleIncomingData(peerId, event.data);
    };
  }

  // "Perfect negotiation" signal handler — handles glare correctly
  async handleSignal(peerId, signal) {
    const pc = this.createConnection(peerId);
    const polite = this._isPolite(peerId);

    if (signal.sdp) {
      const offerCollision =
        (signal.sdp.type === 'offer') &&
        (this._makingOffer.get(peerId) || pc.signalingState !== 'stable');

      const ignoreOffer = !polite && offerCollision;

      if (ignoreOffer) {
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

        // Flush any buffered candidates
        const pending = this._pendingCandidates.get(peerId) || [];
        for (const c of pending) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        this._pendingCandidates.delete(peerId);

        if (signal.sdp.type === 'offer') {
          await pc.setLocalDescription();
          this.signalingClient.sendSignal(peerId, { sdp: pc.localDescription });
        }
      } catch (err) {
        console.error('WebRTC signal handling error:', err);
      }

    } else if (signal.candidate) {
      try {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          // Buffer candidate until remote description is set
          const pending = this._pendingCandidates.get(peerId) || [];
          pending.push(new RTCIceCandidate(signal.candidate));
          this._pendingCandidates.set(peerId, pending);
        }
      } catch (err) {
        console.error('WebRTC signal handling error:', err);
      }
    }
  }

  handleIncomingData(peerId, data) {
    if (typeof data === 'string') {
      const meta = JSON.parse(data);

      if (meta.type === 'header') {
        this.incomingFiles.set(peerId, {
          meta: meta,
          receivedSize: 0,
          chunks: []
        });
        if (this.onTransferStart) this.onTransferStart(peerId, meta.name, 'receive');
        if (this.onProgress) this.onProgress(peerId, meta.name, 0, meta.size, 'receive');

      } else if (meta.type === 'done') {
        const fileData = this.incomingFiles.get(peerId);
        if (!fileData) return;

        // Force progress to 100% (fixes 99% stuck from float rounding)
        if (this.onProgress) this.onProgress(peerId, fileData.meta.name, 100, fileData.meta.size, 'receive');

        const blob = new Blob(fileData.chunks, { type: fileData.meta.mimeType });
        this.incomingFiles.delete(peerId);

        const downloadName = ensureExtension(fileData.meta.name, fileData.meta.mimeType);

        // Send ACK immediately
        const channel = this.channels.get(peerId);
        if (channel && channel.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'ack', filename: downloadName }));
        }
        // Also send ACK via signaling as backup (in case data channel is flaky)
        this.signalingClient.sendSignal(peerId, { action: 'ack', filename: downloadName });

        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);

        if (this.onFileComplete) this.onFileComplete(peerId, downloadName, 'receive');

      } else if (meta.type === 'ack') {
        if (this.onFileComplete) this.onFileComplete(peerId, meta.filename, 'send');

      } else if (meta.type === 'cancel') {
        this.incomingFiles.delete(peerId);
        if (this.onProgress) this.onProgress(peerId, meta.filename || 'file', -1, 0, 'receive');
      }

    } else {
      const fileData = this.incomingFiles.get(peerId);
      if (fileData) {
        fileData.chunks.push(data);
        fileData.receivedSize += data.byteLength;
        const progress = Math.min((fileData.receivedSize / fileData.meta.size) * 100, 100);
        if (this.onProgress) this.onProgress(peerId, fileData.meta.name, progress, fileData.meta.size, 'receive');
      }
    }
  }

  cancelSend(peerId) {
    const sendState = this.activeSends.get(peerId);
    if (sendState) {
      sendState.cancelled = true;
      const channel = this.channels.get(peerId);
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'cancel', filename: sendState.filename }));
      }
      this.activeSends.delete(peerId);
    }
  }

  cancelReceive(peerId) {
    this.incomingFiles.delete(peerId);
  }

  sendFile(peerId, file, retryCount = 0) {
    const channel = this.channels.get(peerId);

    // Check if we have an open channel
    if (channel && channel.readyState === 'open') {
      console.log(`[WebRTC] Open channel found for peer ${peerId}, using direct connection`);
      // Direct connection available - use it immediately
      this._sendFileDirect(peerId, file);
      return;
    }

    // No direct connection - try to establish one
    if (retryCount === 0) {
      console.log(`[WebRTC] No open channel for peer ${peerId}, attempting to establish direct connection (attempt ${retryCount + 1})`);
      this.preConnect(peerId);

      // Set up a timeout to fall back to relay if direct connection takes too long
      const timeoutId = setTimeout(() => {
        if (this.channels.get(peerId)?.readyState !== 'open') {
          // Direct connection failed or taking too long, warn and fall back to relay
          console.log(`[WebRTC] Direct connection timeout for peer ${peerId}, falling back to relay`);
          this._warnAboutRelayUsage(peerId, file.size);
          this.sendFileRelay(peerId, file);
          this._connectionTimeouts.delete(peerId);
        }
      }, 5000); // 5 second timeout for direct connection attempt

      this._connectionTimeouts.set(peerId, timeoutId);
    } else if (retryCount < 4) {
      console.log(`[WebRTC] Retrying direct connection for peer ${peerId} (attempt ${retryCount + 1})`);
      setTimeout(() => this.sendFile(peerId, file, retryCount + 1), 2000);
    } else {
      // Clear timeout if it exists
      if (this._connectionTimeouts.has(peerId)) {
        clearTimeout(this._connectionTimeouts.get(peerId));
        this._connectionTimeouts.delete(peerId);
      }

      // Warn user about potential data usage when falling back to relay
      console.log(`[WebRTC] Max retries reached for peer ${peerId}, falling back to relay`);
      this._warnAboutRelayUsage(peerId, file.size);
      this.sendFileRelay(peerId, file);
    }
  }

  _sendFileDirect(peerId, file) {
    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') {
      console.warn(`[WebRTC] No open channel for peer ${peerId}, cannot send file directly`);
      return;
    }

    console.log(`[WebRTC] Starting direct file transfer to peer ${peerId}: ${file.name} (${file.size} bytes)`);

    const fileName = ensureExtension(file.name, file.type);
    const sendState = { cancelled: false, filename: fileName };
    this.activeSends.set(peerId, sendState);

    if (this.onTransferStart) this.onTransferStart(peerId, fileName, 'send');

    const header = { type: 'header', name: fileName, size: file.size, mimeType: file.type };
    channel.send(JSON.stringify(header));
    if (this.onProgress) this.onProgress(peerId, fileName, 0, file.size, 'send');

    let offset = 0;
    const reader = new FileReader();

    reader.onload = (e) => {
      const sendNextChunk = () => {
        if (sendState.cancelled) {
          console.log(`[WebRTC] File send cancelled for peer ${peerId}`);
          this.activeSends.delete(peerId);
          return;
        }

        if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            sendNextChunk();
          };
          return;
        }

        channel.send(e.target.result);
        offset += e.target.result.byteLength;

        const progress = Math.min((offset / file.size) * 100, 100);
        if (this.onProgress) this.onProgress(peerId, fileName, progress, file.size, 'send');

        if (offset < file.size) {
          readSlice(offset);
        } else {
          // Force sender progress to exactly 100%
          if (this.onProgress) this.onProgress(peerId, fileName, 100, file.size, 'send');
          channel.send(JSON.stringify({ type: 'done' }));
          this.activeSends.delete(peerId);

          // ACK timeout fallback: if no ACK in 8s, auto-complete
          // (handles edge case where ACK message is lost)
          setTimeout(() => {
            if (this.onFileComplete) this.onFileComplete(peerId, fileName, 'send');
          }, 8000);
        }
      };
      sendNextChunk();
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    channel.bufferedAmountLowThreshold = 16 * 1024 * 1024;
    readSlice(0);
  }


  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  }

  handleRelayData(peerId, rawPayload) {
    let msg;
    try { msg = JSON.parse(rawPayload); } catch { return; }
    if (msg.type === 'header' || msg.type === 'done' || msg.type === 'ack' || msg.type === 'cancel') {
      this.handleIncomingData(peerId, rawPayload);
    } else if (msg.type === 'chunk') {
      const binaryString = window.atob(msg.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      this.handleIncomingData(peerId, bytes.buffer);
    }
  }

  // Warn user about potential data usage when using relay
  _warnAboutRelayUsage(peerId, fileSize) {
    // Only show warning once per peer per session
    if (this._relayWarningShown.has(peerId)) return;

    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    const warningMsg = `⚠️ Direct connection failed. Using relay mode which may consume up to ${sizeMB} MB of your data. For best results, ensure both devices are on the same network.`;

    // Show toast notification (we'll need to access UIManager for this)
    // For now, we'll log to console and rely on UI to show visual indicators
    console.warn(warningMsg);
    this._relayWarningShown.add(peerId);
  }

  sendFileRelay(peerId, file) {
    const fileName = ensureExtension(file.name, file.type);
    const sendState = { cancelled: false, filename: fileName };
    this.activeSends.set(peerId, sendState);

    if (this.onTransferStart) this.onTransferStart(peerId, fileName, 'send');

    const header = { type: 'header', name: fileName, size: file.size, mimeType: file.type };
    this.signalingClient.sendRelay(peerId, JSON.stringify(header));
    if (this.onProgress) this.onProgress(peerId, fileName, 0, file.size, 'send');

    let offset = 0;
    const reader = new FileReader();

    reader.onload = (e) => {
      if (sendState.cancelled) { this.activeSends.delete(peerId); return; }

      const base64 = this.arrayBufferToBase64(e.target.result);
      this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'chunk', data: base64 }));
      offset += e.target.result.byteLength;

      const progress = Math.min((offset / file.size) * 100, 100);
      if (this.onProgress) this.onProgress(peerId, fileName, progress, file.size, 'send');

      if (offset < file.size) {
        setTimeout(() => readSlice(offset), 10);
      } else {
        this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'done' }));
        this.activeSends.delete(peerId);
        if (this.onFileComplete) this.onFileComplete(peerId, fileName, 'send');
      }
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + RELAY_CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  }

    // Wake Lock to prevent screen from sleeping during transfers
  async _requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          console.log('Wake Lock was released');
          this.wakeLock = null;
        });
        console.log('Wake Lock is active');
      }
    } catch (err) {
      console.error(`${err.name}, ${err.message}`);
    }
  }

  async _releaseWakeLock() {
    if (this.wakeLock) {
      await this.wakeLock.release();
      this.wakeLock = null;
      console.log('Wake Lock released');
    }
  }

  // Pause all active transfers (called when app goes to background/screen off)
  // We keep transfers active; only UI updates might be affected.
  pauseTransfers() {
    // No-op: transfers continue via WebRTC data channels; wake lock keeps screen awake.
  }

  // Resume all transfers (when app comes to foreground)
  // No-op: transfers were never paused.
  resumeTransfers() {
    // No-op
  }

  // Track active transfers for wake lock management
  _incrementActiveTransfers() {
    this.activeTransferCount++;
    if (this.activeTransferCount === 1) {
      // First transfer started, request wake lock
      this._requestWakeLock();
    }
  }

  _decrementActiveTransfers() {
    if (this.activeTransferCount > 0) {
      this.activeTransferCount--;
      if (this.activeTransferCount === 0) {
        // No more active transfers, release wake lock
        this._releaseWakeLock();
      }
    }
  }

  getActiveTransferCount() {
    return this.activeTransferCount;
  }
}
