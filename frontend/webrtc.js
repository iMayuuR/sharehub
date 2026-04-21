// webrtc.js
const CHUNK_SIZE = 64 * 1024; // 64KB per chunk

export class WebRTCManager {
  constructor(signalingClient, onProgress, onFileComplete) {
    this.signalingClient = signalingClient;
    this.onProgress = onProgress;
    this.onFileComplete = onFileComplete;
    this.onTransferStart = null; // Called with (peerId, filename, direction: 'send'|'receive')
    this.connections = new Map();
    this.channels = new Map();
    this.incomingFiles = new Map();
  }

  createConnection(peerId, isInitiator) {
    if (this.connections.has(peerId)) return this.connections.get(peerId);

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
      iceCandidatePoolSize: 10 // Pre-gather ICE candidates for faster connection in complex networks
    };

    const pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.sendSignal(peerId, { candidate: event.candidate });
      }
    };

    if (isInitiator) {
      const channel = pc.createDataChannel('fileTransfer');
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

  setupChannel(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    this.channels.set(peerId, channel);

    channel.onopen = () => {};
    channel.onclose = () => {
      this.channels.delete(peerId);
      this.connections.delete(peerId);
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
        // Notify UI: receiving file from peer
        if (this.onTransferStart) this.onTransferStart(peerId, meta.name, 'receive');
        if (this.onProgress) this.onProgress(peerId, meta.name, 0, meta.size, 'receive');

      } else if (meta.type === 'done') {
        const fileData = this.incomingFiles.get(peerId);
        if (!fileData) return;

        const blob = new Blob(fileData.chunks, { type: fileData.meta.mimeType });
        this.incomingFiles.delete(peerId);

        // Send ACK back to sender
        const channel = this.channels.get(peerId);
        if (channel && channel.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'ack', filename: fileData.meta.name }));
        }

        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileData.meta.name;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);

        if (this.onFileComplete) this.onFileComplete(peerId, fileData.meta.name, 'receive');

      } else if (meta.type === 'ack') {
        // Sender received ACK from receiver — file delivered successfully
        if (this.onFileComplete) this.onFileComplete(peerId, meta.filename, 'send');
      }

    } else {
      // Binary chunk
      const fileData = this.incomingFiles.get(peerId);
      if (fileData) {
        fileData.chunks.push(data);
        fileData.receivedSize += data.byteLength;
        const progress = Math.min((fileData.receivedSize / fileData.meta.size) * 100, 100);
        if (this.onProgress) this.onProgress(peerId, fileData.meta.name, progress, fileData.meta.size, 'receive');
      }
    }
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

    // Notify UI: sending file to peer
    if (this.onTransferStart) this.onTransferStart(peerId, file.name, 'send');

    const header = {
      type: 'header',
      name: file.name,
      size: file.size,
      mimeType: file.type
    };
    channel.send(JSON.stringify(header));

    if (this.onProgress) this.onProgress(peerId, file.name, 0, file.size, 'send');

    let offset = 0;
    const reader = new FileReader();

    reader.onload = (e) => {
      const sendNextChunk = () => {
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
         }
      }
      sendNextChunk();
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    channel.bufferedAmountLowThreshold = 1000000;
    readSlice(0);
  }

  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  handleRelayData(peerId, rawPayload) {
    let msg;
    try { msg = JSON.parse(rawPayload); } catch { return; }
    if (msg.type === 'header' || msg.type === 'done' || msg.type === 'ack') {
        this.handleIncomingData(peerId, rawPayload);
    } else if (msg.type === 'chunk') {
        const binaryString = window.atob(msg.data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        this.handleIncomingData(peerId, bytes.buffer);
    }
  }

  sendFileRelay(peerId, file) {
    if (this.onTransferStart) this.onTransferStart(peerId, file.name, 'send');

    const header = { type: 'header', name: file.name, size: file.size, mimeType: file.type };
    this.signalingClient.sendRelay(peerId, JSON.stringify(header));
    if (this.onProgress) this.onProgress(peerId, file.name, 0, file.size, 'send');

    let offset = 0;
    const reader = new FileReader();

    reader.onload = (e) => {
      const base64 = this.arrayBufferToBase64(e.target.result);
      this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'chunk', data: base64 }));
      offset += e.target.result.byteLength;

      const progress = Math.min((offset / file.size) * 100, 100);
      if (this.onProgress) this.onProgress(peerId, file.name, progress, file.size, 'send');

      if (offset < file.size) {
        setTimeout(() => readSlice(offset), 10);
      } else {
        this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'done' }));
        if (this.onFileComplete) this.onFileComplete(peerId, file.name, 'send');
      }
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + 16 * 1024);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  }
}
