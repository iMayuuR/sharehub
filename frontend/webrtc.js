// webrtc.js

// Adaptive chunk size: 256KB for max speed on local connections
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
  if (lastDot > 0 && lastDot > name.length - 8) return name; // Already has extension
  const ext = MIME_TO_EXT[mimeType] || '';
  return ext ? name + ext : name;
}
export class WebRTCManager {
  constructor(signalingClient, onProgress, onFileComplete) {
    this.signalingClient = signalingClient;
    this.onProgress = onProgress;
    this.onFileComplete = onFileComplete;
    this.onTransferStart = null;
    this.connections = new Map();
    this.channels = new Map();
    this.incomingFiles = new Map();
    this.activeSends = new Map(); // peerId -> { cancelled: bool } for cancel support
  }

  createConnection(peerId, isInitiator) {
    if (this.connections.has(peerId)) {
      const existing = this.connections.get(peerId);
      // If connection is still alive, reuse it
      if (existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
        return existing;
      }
      // Otherwise clean up and create new
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
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.connections.delete(peerId);
        this.channels.delete(peerId);
      }
    };

    if (isInitiator) {
      // Create high-throughput data channel
      const channel = pc.createDataChannel('fileTransfer', {
        ordered: true,
        maxRetransmits: 30
      });
      this.setupChannel(peerId, channel);

      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        this.signalingClient.sendSignal(peerId, { sdp: pc.localDescription });
      }).catch(e => console.error("Error creating offer", e));
    } else {
      pc.ondatachannel = (event) => {
        this.setupChannel(peerId, event.channel);
      };
    }

    this.connections.set(peerId, pc);
    return pc;
  }

  // Pre-connect to a peer as soon as they're discovered (for instant file transfer later)
  preConnect(peerId) {
    if (!this.connections.has(peerId) && !this.channels.has(peerId)) {
      this.createConnection(peerId, true);
    }
  }

  setupChannel(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    // Set high buffer threshold for speed
    if (typeof channel.bufferedAmountLowThreshold !== 'undefined') {
      channel.bufferedAmountLowThreshold = 2 * 1024 * 1024; // 2MB buffer
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

  handleSignal(peerId, signal) {
    const pc = this.createConnection(peerId, false);

    if (signal.sdp) {
      pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(() => {
        if (pc.remoteDescription.type === 'offer') {
          return pc.createAnswer().then(answer => {
            return pc.setLocalDescription(answer);
          }).then(() => {
            this.signalingClient.sendSignal(peerId, { sdp: pc.localDescription });
          });
        }
      }).catch(e => console.error("Error setting session description", e));
    } else if (signal.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(e => console.error("Error adding Ice Candidate", e));
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

        const blob = new Blob(fileData.chunks, { type: fileData.meta.mimeType });
        this.incomingFiles.delete(peerId);

        // Fix filename extension if missing
        const downloadName = ensureExtension(fileData.meta.name, fileData.meta.mimeType);

        // Send ACK
        const channel = this.channels.get(peerId);
        if (channel && channel.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'ack', filename: downloadName }));
        }

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
        // Sender cancelled — discard partial data
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

  // Cancel an ongoing send
  cancelSend(peerId) {
    const sendState = this.activeSends.get(peerId);
    if (sendState) {
      sendState.cancelled = true;
      // Notify receiver
      const channel = this.channels.get(peerId);
      if (channel && channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'cancel', filename: sendState.filename }));
      }
      this.activeSends.delete(peerId);
    }
  }

  // Cancel an ongoing receive
  cancelReceive(peerId) {
    this.incomingFiles.delete(peerId);
  }

  sendFile(peerId, file, retryCount = 0) {
    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') {
      if (retryCount === 0) {
        this.createConnection(peerId, true);
      }
      if (retryCount < 4) {
        setTimeout(() => this.sendFile(peerId, file, retryCount + 1), 2000);
      } else {
        this.sendFileRelay(peerId, file);
      }
      return;
    }

    // Track send state for cancel support
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
        // Check if cancelled
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
        if (this.onProgress) this.onProgress(peerId, file.name, progress, file.size, 'send');

        if (offset < file.size) {
          readSlice(offset);
        } else {
          channel.send(JSON.stringify({ type: 'done' }));
          this.activeSends.delete(peerId);
        }
      };
      sendNextChunk();
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    channel.bufferedAmountLowThreshold = 2 * 1024 * 1024; // 2MB for speed
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
    if (this.onProgress) this.onProgress(peerId, file.name, 0, file.size, 'send');

    let offset = 0;
    const reader = new FileReader();

    reader.onload = (e) => {
      if (sendState.cancelled) { this.activeSends.delete(peerId); return; }

      const base64 = this.arrayBufferToBase64(e.target.result);
      this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'chunk', data: base64 }));
      offset += e.target.result.byteLength;

      const progress = Math.min((offset / file.size) * 100, 100);
      if (this.onProgress) this.onProgress(peerId, file.name, progress, file.size, 'send');

      if (offset < file.size) {
        setTimeout(() => readSlice(offset), 10);
      } else {
        this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'done' }));
        this.activeSends.delete(peerId);
        if (this.onFileComplete) this.onFileComplete(peerId, file.name, 'send');
      }
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + RELAY_CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  }
}
