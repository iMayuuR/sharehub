// webrtc.js

const CHUNK_SIZE = 256 * 1024;
const RELAY_CHUNK_SIZE = 16 * 1024;

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
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
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
        }
      ],
      iceCandidatePoolSize: 10
    };

    const pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.sendSignal(peerId, { candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] ${peerId.substring(0,8)} state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        // Auto-restart on failure
        this.connections.delete(peerId);
        this.channels.delete(peerId);
      }
    };

    pc.ondatachannel = (event) => {
      console.log(`[WebRTC] Got data channel from ${peerId.substring(0,8)}`);
      this.setupChannel(peerId, event.channel);
    };

    // Negotiation needed — handles both initial and renegotiation
    pc.onnegotiationneeded = async () => {
      try {
        this._makingOffer.set(peerId, true);
        await pc.setLocalDescription();
        this.signalingClient.sendSignal(peerId, { sdp: pc.localDescription });
      } catch (e) {
        console.error('[WebRTC] Negotiation error:', e);
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
      console.log(`[WebRTC] I'm impolite, initiating to ${peerId.substring(0,8)}`);
      const channel = pc.createDataChannel('fileTransfer', {
        ordered: true,
        maxRetransmits: 30
      });
      this.setupChannel(peerId, channel);
    } else {
      console.log(`[WebRTC] I'm polite, waiting for ${peerId.substring(0,8)} to initiate`);
    }
  }

  setupChannel(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    if (typeof channel.bufferedAmountLowThreshold !== 'undefined') {
      channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;
    }
    this.channels.set(peerId, channel);

    channel.onopen = () => {
      console.log(`[WebRTC] Channel OPEN with ${peerId.substring(0,8)} ✅`);
    };
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
        console.log(`[WebRTC] Ignoring colliding offer from ${peerId.substring(0,8)} (I'm impolite)`);
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
      } catch (e) {
        console.error('[WebRTC] Signal handling error:', e);
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
      } catch (e) {
        console.error('[WebRTC] ICE candidate error:', e);
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
    if (!channel || channel.readyState !== 'open') {
      if (retryCount === 0) {
        this.preConnect(peerId);
      }
      if (retryCount < 4) {
        setTimeout(() => this.sendFile(peerId, file, retryCount + 1), 2000);
      } else {
        this.sendFileRelay(peerId, file);
      }
      return;
    }

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

    channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;
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
}
