// webrtc.js - Enhanced logging for debugging

// 2MB chunks for direct transfers — local network high throughput
const CHUNK_SIZE = 2 * 1024 * 1024;
// 256KB relay chunks (base64 overhead is ~33%, keep smaller)
const RELAY_CHUNK_SIZE = 256 * 1024;

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
    this._makingOffer = new Map();
    this._pendingCandidates = new Map();
    this._relayWarningShown = new Set();
    this._connectionTimeouts = new Map();
    this.activeTransferCount = 0;
    this.wakeLock = null;
    this._pendingFiles = new Map(); // peerId → file currently being sent (for channel-close recovery)
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
        maxPacketLifeTime: 250, // 250ms max — faster delivery for local network
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

    channel.onopen = () => {
      // Resume any file that was mid-send when channel closed
      const pending = this._pendingFiles.get(peerId);
      if (pending) {
        console.log(`[WebRTC] Resuming after channel reopen: ${pending.name}`);
        this._enqueueFile(peerId, pending);
        this._pendingFiles.delete(peerId);
      }
      this._processQueue(peerId);
    };
    channel.onclose = () => {
      this.channels.delete(peerId);
      // Note: queue is NOT destroyed here — _sendFileDirect will handle recovery.
      // _pendingFiles is set when an active send loses its channel.
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
    // Initialize inbound header queue map if not present
    if (!this._incomingHeaderQueue) this._incomingHeaderQueue = new Map();

    if (typeof data === 'string') {
      const meta = JSON.parse(data);

      if (meta.type === 'header') {
        // If a file is already being received, queue this header for later processing
        if (this.incomingFiles.has(peerId)) {
          if (!this._incomingHeaderQueue.has(peerId)) this._incomingHeaderQueue.set(peerId, []);
          this._incomingHeaderQueue.get(peerId).push(meta);
          console.warn(`[WebRTC] Queued header for "${meta.name}" – another file in progress from ${peerId}`);
          return;
        }
        // Per-peer flow state for throughput feedback to sender
        if (!this._flowState) this._flowState = new Map();
        this._flowState.set(peerId, {
          bytes: 0,
          chunks: 0,
          reportTime: Date.now()
        });
        this.incomingFiles.set(peerId, {
          meta: meta,
          receivedSize: 0,
          chunks: []
        });
        if (this.onTransferStart) this.onTransferStart(peerId, meta.name, 'receive');
        if (this.onProgress) this.onProgress(peerId, meta.name, 0, meta.size, 'receive');

      } else if (meta.type === 'flow') {
        // Sender-side: adaptive flow control from receiver feedback
        this._adjustFlowControl(peerId, meta);
        return;

      } else if (meta.type === 'done') {
        const fileData = this.incomingFiles.get(peerId);
        if (!fileData) return;

        // Final throughput report to sender & cleanup flow state
        if (this._flowState) {
          const fl = this._flowState.get(peerId);
          if (fl) {
            const elapsed = (Date.now() - fl.reportTime) / 1000;
            if (elapsed > 0) {
              const mbps = (fileData.receivedSize / elapsed / 1024 / 1024).toFixed(2);
              const ch = this.channels.get(peerId);
              if (ch && ch.readyState === 'open') {
                ch.send(JSON.stringify({ type: 'done', filename: fileData.meta.name, avgMbps: parseFloat(mbps) }));
              }
            }
            this._flowState.delete(peerId);
          }
        }

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

        // After completing, check if there are queued headers and process the next one
        if (this._incomingHeaderQueue.has(peerId)) {
          const q = this._incomingHeaderQueue.get(peerId);
          if (q.length) {
            const nextMeta = q.shift();
            // Process the next header as a new incoming file
            this.handleIncomingData(peerId, JSON.stringify(nextMeta));
          }
          if (q.length === 0) this._incomingHeaderQueue.delete(peerId);
        }

      } else if (meta.type === 'ack') {
        // Adjust flow control for future sends based on observed throughput
        if (meta.avgMbps) this._adjustFlowControl(peerId, { mbps: meta.avgMbps });
        if (this.onFileComplete) this.onFileComplete(peerId, meta.filename, 'send');
        // ACK received — clear waiting flag so next queued file can start
        if (this._senderWaitingAck) this._senderWaitingAck.delete(peerId);
        console.log(`[WebRTC] ACK received for ${meta.filename} from ${peerId}, resuming queue`);
        this._processQueue(peerId);

      } else if (meta.type === 'cancel') {
        this.incomingFiles.delete(peerId);
        if (this._flowState?.has(peerId)) this._flowState.delete(peerId);
        if (this.onProgress) this.onProgress(peerId, meta.filename || 'file', -1, 0, 'receive');
      }

    } else {
      // Binary chunk
      const fileData = this.incomingFiles.get(peerId);
      if (fileData) {
        fileData.chunks.push(data);
        fileData.receivedSize += data.byteLength;
        const progress = Math.min((fileData.receivedSize / fileData.meta.size) * 100, 100);
        if (this.onProgress) this.onProgress(peerId, fileData.meta.name, progress, fileData.meta.size, 'receive');

        // Update flow state and send periodic throughput report to sender
        if (this._flowState) {
          const fl = this._flowState.get(peerId);
          if (fl) {
            fl.bytes += data.byteLength;
            fl.chunks++;
            const elapsed = Date.now() - fl.reportTime;
            if (elapsed >= 2000) { // Report every 2s
              const mbps = (fl.bytes / (elapsed / 1000) / 1024 / 1024).toFixed(2);
              const ch = this.channels.get(peerId);
              if (ch && ch.readyState === 'open') {
                ch.send(JSON.stringify({ type: 'flow', mbps: parseFloat(mbps), chunks: fl.chunks }));
              }
              fl.bytes = 0;
              fl.chunks = 0;
              fl.reportTime = Date.now();
            }
          }
        }
      }
    }
  }

  sendFile(peerId, file, retryCount = 0) {
    const channel = this.channels.get(peerId);

    if (channel && channel.readyState === 'open') {
      // Direct connection — enqueue for sequential multi-file transfer
      console.log(`[WebRTC] Open channel for ${peerId}, queuing: ${file.name}`);
      this._enqueueFile(peerId, file);
      return;
    }
    // No open channel
    if (retryCount === 0) {
      console.log(`[WebRTC] No channel for ${peerId}, establishing...`);
      this.preConnect(peerId);
      this._enqueueFile(peerId, file);

      const timeoutId = setTimeout(() => {
        if (this.channels.get(peerId)?.readyState !== 'open') {
          console.log(`[WebRTC] Channel not open after 5s, retrying...`);
          this.sendFile(peerId, file, 1);
        }
        this._connectionTimeouts.delete(peerId);
      }, 5000);
      this._connectionTimeouts.set(peerId, timeoutId);

    } else if (retryCount < 4) {
      console.log(`[WebRTC] Retry ${retryCount} for ${peerId}`);
      this.preConnect(peerId);
      // No re-enqueue: file already queued from first sendFile call.
      // channel.onopen → _processQueue will pick it up.
      setTimeout(() => this.sendFile(peerId, file, retryCount + 1), 2000);

    } else {
      // Max retries — clear direct queue and fall to relay
      if (this._fileQueues?.has(peerId)) {
        const q = this._fileQueues.get(peerId);
        // Remove the specific file from queue (it's the first one)
        const idx = q.findIndex(f => f === file);
        if (idx !== -1) q.splice(idx, 1);
      }
      console.log(`[WebRTC] Max retries for ${peerId}, relay fallback`);
      this._warnAboutRelayUsage(peerId, file.size);
      this.sendFileRelay(peerId, file);
    }
  }

  // Per-peer file queue — ensures multiple files are sent sequentially
  _enqueueFile(peerId, file) {
    if (!this._fileQueues) this._fileQueues = new Map();
    if (!this._fileQueues.has(peerId)) this._fileQueues.set(peerId, []);
    this._fileQueues.get(peerId).push(file);
    // Kick off processing if this is the only file in queue
    if (this._fileQueues.get(peerId).length === 1) {
      this._processQueue(peerId);
    }
  }

  _processQueue(peerId) {
    if (!this._fileQueues) this._fileQueues = new Map();
    const queue = this._fileQueues.get(peerId);
    if (!queue || queue.length === 0) return;

    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') return;

    // Don't start next file if still waiting for ACK of previous file
    if (this._senderWaitingAck?.get(peerId)) {
      console.log(`[WebRTC] Queue blocked for ${peerId}: still waiting for ACK of previous file`);
      return;
    }

    const file = queue[0];
    this._sendFileDirect(peerId, file, () => {
      // on done callback — dequeue and process next
      queue.shift();
      this._processQueue(peerId);
    });
  }

  _sendFileDirect(peerId, file, onDone) {
    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') {
      // Channel closed — DON'T shift queue. _processQueue will retry when channel reopens.
      console.warn(`[WebRTC] Channel not open for ${peerId}, will retry on reopen`);
      return;
    }

    const fileName = ensureExtension(file.name, file.type);
    const fc = this._flowCtrl?.get(peerId);
    const threshold = fc?.threshold || (16 * 1024 * 1024);
    channel.bufferedAmountLowThreshold = threshold;
    console.log(`[WebRTC] Starting direct send to ${peerId}: ${fileName} (${file.size} bytes, threshold=${(threshold/1024/1024).toFixed(1)}MB)`);

    const sendState = { cancelled: false };
    this.activeSends.set(peerId, sendState);

    if (this.onTransferStart) this.onTransferStart(peerId, fileName, 'send');

    const header = { type: 'header', name: fileName, size: file.size, mimeType: file.type };
    channel.send(JSON.stringify(header));
    if (this.onProgress) this.onProgress(peerId, fileName, 0, file.size, 'send');

    let offset = 0;
    let prefetchBuf = null; // Read-ahead buffer
    let prefetchOffset = 0;
    const reader = new FileReader();
    const fileReader2 = new FileReader(); // Second reader for prefetch

    // Read first chunk synchronously
    const firstSlice = file.slice(0, CHUNK_SIZE);
    reader.readAsArrayBuffer(firstSlice);

    const readNextInto = (targetReader, o) => {
      const slice = file.slice(o, o + CHUNK_SIZE);
      targetReader.readAsArrayBuffer(slice);
    };

    // Prefetch next chunk while current one sends
    const prefetchNext = () => {
      if (prefetchOffset < file.size) {
        readNextInto(fileReader2, prefetchOffset);
      }
    };

    // Start prefetching immediately
    prefetchOffset = CHUNK_SIZE;
    prefetchNext();

    const sendChunk = (buf) => {
      if (sendState.cancelled) {
        console.log(`[WebRTC] Send cancelled for ${peerId}`);
        this.activeSends.delete(peerId);
        if (onDone) onDone();
        return;
      }

      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        const handler = () => {
          channel.onbufferedamountlow = null;
          sendChunk(buf);
        };
        channel.onbufferedamountlow = handler;
        return;
      }

      try {
        channel.send(buf);
      } catch (err) {
        if (err.name === 'OperationError' && err.message.includes('send queue is full')) {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            sendChunk(buf);
          };
          return;
        }
        throw err;
      }

      offset += buf.byteLength;
      const progress = Math.min((offset / file.size) * 100, 100);
      if (this.onProgress) this.onProgress(peerId, fileName, progress, file.size, 'send');

      if (offset >= file.size) {
        if (this.onProgress) this.onProgress(peerId, fileName, 100, file.size, 'send');
        channel.send(JSON.stringify({ type: 'done' }));
        this.activeSends.delete(peerId);
        // Wait for peer ACK before dequeue — prevents file2 chunks from mixing with
        // file1 chunks on receiver when peer hasn't confirmed file1 yet
        if (!this._senderWaitingAck) this._senderWaitingAck = new Map();
        this._senderWaitingAck.set(peerId, true);
        setTimeout(() => {
          // Safety: if ACK didn't arrive in 8s, still allow next file (proceed)
          if (this._senderWaitingAck?.get(peerId)) {
            this._senderWaitingAck.delete(peerId);
            this._processQueue(peerId); // resume queue
          }
          if (this.onFileComplete) this.onFileComplete(peerId, fileName, 'send');
        }, 8000);
        return;
      }

      // Use prefetched buffer, then read new chunk
      if (prefetchBuf) {
        const tmp = prefetchBuf;
        prefetchBuf = null;

        // Read next into the OTHER reader while we send prefetched
        readNextInto(fileReader2, prefetchOffset);
        prefetchOffset += CHUNK_SIZE;

        sendChunk(tmp);
      } else {
        // No prefetch — block on read (fallback, rare)
        reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
      }
    };

    // Main reader: when first chunk is ready, start sending and prefetch
    reader.onload = (e) => sendChunk(e.target.result);

    fileReader2.onload = (e) => {
      prefetchBuf = e.target.result;
    };
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
    if (msg.type === 'header' || msg.type === 'done' || msg.type === 'ack' || msg.type === 'cancel' || msg.type === 'flow') {
      this.handleIncomingData(peerId, rawPayload);
    } else if (msg.type === 'chunk') {
      // Decode base64 → ArrayBuffer → pass as binary to handleIncomingData
      const binary = atob(msg.data);
      const buf = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
      this.handleIncomingData(peerId, buf.buffer);
    }
  }

  // Warn user about potential data usage when using relay
  _warnAboutRelayUsage(peerId, fileSize) {
    if (this._relayWarningShown.has(peerId)) return;

    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    const warningMsg = `⚠️ Direct connection failed. Using relay mode which may consume up to ${sizeMB} MB of relay data.`;
    console.warn(warningMsg);
    this._relayWarningShown.add(peerId);
  }

  // Adaptive flow control — adjusts in-flight buffer based on receiver throughput
  // Slow receiver (e.g., 4G 5 Mbps) → reduce threshold so sender doesn't overwhelm
  // Fast receiver (e.g., WiFi 50 Mbps) → keep high threshold for max throughput
  _adjustFlowControl(peerId, meta) {
    if (!this._flowCtrl) this._flowCtrl = new Map();
    let fc = this._flowCtrl.get(peerId);
    if (!fc) {
      fc = { threshold: 16 * 1024 * 1024, lastMbps: 0, steadySends: 0 };
      this._flowCtrl.set(peerId, fc);
    }

    const mbps = meta.mbps || meta.avgMbps || fc.lastMbps;
    fc.lastMbps = mbps;

    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') return;

    const buf = channel.bufferedAmount;
    const prev = fc.threshold;

    // Slow connection (mobile 4G <8 Mbps): cap threshold lower
    // Fast connection (>20 Mbps): allow more in-flight for max throughput
    if (mbps < 8) {
      // Halve threshold, min 1MB — prevents buffering too much on slow link
      fc.threshold = Math.max(1024 * 1024, fc.threshold * 0.5);
    } else if (mbps > 20 && buf < fc.threshold * 0.5) {
      // Fast + buffer draining fast: increase, max 32MB
      fc.threshold = Math.min(32 * 1024 * 1024, fc.threshold * 1.25);
    }

    // Apply new threshold if changed significantly
    if (Math.abs(fc.threshold - prev) > 256 * 1024) {
      if (channel.bufferedAmountLowThreshold !== undefined) {
        channel.bufferedAmountLowThreshold = fc.threshold;
      }
      console.log(`[FlowCtrl] ${peerId}: ${mbps} Mbps → threshold ${(prev/1024/1024).toFixed(1)}MB → ${(fc.threshold/1024/1024).toFixed(1)}MB, buf=${(buf/1024/1024).toFixed(1)}MB`);
    }
  }

  sendFileRelay(peerId, file) {
    // Enqueue for relay too — prevents overwriting
    if (!this._relayQueues) this._relayQueues = new Map();
    if (!this._relayQueues.has(peerId)) this._relayQueues.set(peerId, []);
    this._relayQueues.get(peerId).push(file);
    if (this._relayQueues.get(peerId).length === 1) {
      this._processRelayQueue(peerId);
    }
  }

  _processRelayQueue(peerId) {
    const queue = this._relayQueues.get(peerId);
    if (!queue || queue.length === 0) return;
    const file = queue[0];
    this._sendFileRelayDirect(peerId, file, () => {
      queue.shift();
      this._processRelayQueue(peerId);
    });
  }

  _sendFileRelayDirect(peerId, file, onDone) {
    const fileName = ensureExtension(file.name, file.type);
    const sendState = { cancelled: false };
    this.activeSends.set(peerId, sendState);

    if (this.onTransferStart) this.onTransferStart(peerId, fileName, 'send');

    const header = { type: 'header', name: fileName, size: file.size, mimeType: file.type };
    this.signalingClient.sendRelay(peerId, JSON.stringify(header));
    if (this.onProgress) this.onProgress(peerId, fileName, 0, file.size, 'send');

    let offset = 0;
    const reader = new FileReader();

    reader.onload = (e) => {
      if (sendState.cancelled) { this.activeSends.delete(peerId); if (onDone) onDone(); return; }

      const base64 = this.arrayBufferToBase64(e.target.result);
      this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'chunk', data: base64 }));
      offset += e.target.result.byteLength;

      const progress = Math.min((offset / file.size) * 100, 100);
      if (this.onProgress) this.onProgress(peerId, fileName, progress, file.size, 'send');

      if (offset < file.size) {
        setTimeout(() => readSlice(offset), 8); // Minimal delay for throughput
      } else {
        this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'done' }));
        this.activeSends.delete(peerId);
        if (this.onFileComplete) this.onFileComplete(peerId, fileName, 'send');
        if (onDone) onDone();
      }
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + RELAY_CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  }

  cancelSend(peerId) {
    // Cancel current file being sent
    const sendState = this.activeSends.get(peerId);
    if (sendState) {
      sendState.cancelled = true;
    }
    // Clear all queued files for this peer
    if (this._fileQueues?.has(peerId)) this._fileQueues.delete(peerId);
    if (this._relayQueues?.has(peerId)) this._relayQueues.delete(peerId);
    if (this._pendingFiles?.has(peerId)) this._pendingFiles.delete(peerId);
    // Notify receiver so they don't wait
    const channel = this.channels.get(peerId);
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'cancel', filename: '' }));
    }
    this.activeSends.delete(peerId);
  }

  cancelReceive(peerId) {
    this.incomingFiles.delete(peerId);
    // Clean up flow state too so next file is accepted cleanly
    if (this._flowState?.has(peerId)) this._flowState.delete(peerId);
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
