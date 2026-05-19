// webrtc.js - Enhanced logging for debugging
import { fileKey, enqueueFile, dequeueIfHead, queueRemaining } from './transfer-queue.js';

// 4MB chunks — balance throughput vs browser SCTP limits
const CHUNK_SIZE = 4 * 1024 * 1024;
// MUST stay below browser SCTP buffer (~16MB). 64MB breaks bufferedamountlow → send hangs forever.
const LAN_BUFFER_THRESHOLD = 4 * 1024 * 1024;
const LAN_BUFFER_THRESHOLD_MAX = 16 * 1024 * 1024;
// 256KB relay chunks (base64 overhead is ~33%, keep smaller)
const RELAY_CHUNK_SIZE = 256 * 1024;
const SEND_ACK_FALLBACK_MS = 15000;

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
    this.onSendFailed = null;
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
    this._sending = new Map(); // peerId → true while a direct send is active
    this._completedSendKeys = new Set(); // dedupe onFileComplete
    this._batchTotals = new Map(); // peerId → total files in current batch
    this._ackFallbackTimers = new Map(); // ackKey → timeout id
    this._sendTimers = new Map(); // peerId → connection wait timer
  }

  /** Idempotent send-complete (data channel ACK, signaling ACK, or fallback timer). */
  _completeSend(peerId, filename) {
    const ackKey = `${peerId}:send:${filename}`;
    if (this._completedSendKeys.has(ackKey)) return false;
    this._completedSendKeys.add(ackKey);
    const t = this._ackFallbackTimers.get(ackKey);
    if (t) {
      clearTimeout(t);
      this._ackFallbackTimers.delete(ackKey);
    }
    if (this.onFileComplete) this.onFileComplete(peerId, filename, 'send');
    return true;
  }

  /** Queue multiple files for one peer — sends back-to-back on same data channel */
  sendFiles(peerId, files) {
    if (!files?.length) return;
    const list = Array.from(files);
    console.log(`[WebRTC] Queuing ${list.length} file(s) for ${peerId}`);
    this._batchTotals.set(peerId, list.length);
    for (const file of list) this._enqueueFile(peerId, file, true);
    this._pendingFiles.set(peerId, list[0]);
    this._armSend(peerId, 0);
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
      console.log(`[WebRTC] PC ${peerId.substring(0, 8)} connectionState=${pc.connectionState} ice=${pc.iceConnectionState}`);
      if (pc.connectionState === 'connected') {
        const ch = this.channels.get(peerId);
        if (ch?.readyState === 'open') this._processQueue(peerId);
      }
      if (pc.connectionState === 'failed') {
        const hasQueuedFiles = this._fileQueues?.get(peerId)?.length > 0;
        if (hasQueuedFiles) {
          console.log(`[WebRTC] Direct connection failed for ${peerId}, falling back to relay instantly`);
          this._clearSendTimer(peerId);
          this._closeConnectionForPeer(peerId);
          this._flushQueueToRelay(peerId);
        } else {
          this.connections.delete(peerId);
          this.channels.delete(peerId);
        }
      } else if (pc.connectionState === 'closed') {
        this.connections.delete(peerId);
        this.channels.delete(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        const ch = this.channels.get(peerId);
        if (ch?.readyState === 'open') this._processQueue(peerId);
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

  // Pre-connect: impolite peer (larger ID) creates the data channel
  preConnect(peerId) {
    const ch = this.channels.get(peerId);
    if (ch?.readyState === 'open' || ch?.readyState === 'connecting') return;

    const pc = this.createConnection(peerId);
    if (!this._isPolite(peerId)) {
      const channel = pc.createDataChannel('fileTransfer', { ordered: true });
      this.setupChannel(peerId, channel);
    }
  }

  _clearSendTimer(peerId) {
    const t = this._sendTimers.get(peerId);
    if (t) clearTimeout(t);
    this._sendTimers.delete(peerId);
    const legacy = this._connectionTimeouts.get(peerId);
    if (legacy) clearTimeout(legacy);
    this._connectionTimeouts.delete(peerId);
  }

  /** Wait for data channel — do NOT tear down while ICE is still negotiating. */
  _armSend(peerId, retryCount = 0, negotiateWaits = 0) {
    const ch = this.channels.get(peerId);
    if (ch?.readyState === 'open') {
      this._clearSendTimer(peerId);
      this._processQueue(peerId);
      return;
    }

    const pc = this.connections.get(peerId) || this.createConnection(peerId);

    if (retryCount === 0) {
      this.preConnect(peerId);
    }

    // Polite peer: remote may not have opened yet — create channel on retry
    if (retryCount >= 1 && this._isPolite(peerId) && !this.channels.has(peerId)) {
      const channel = pc.createDataChannel('fileTransfer', { ordered: true });
      this.setupChannel(peerId, channel);
      console.log(`[WebRTC] Polite peer opening data channel to ${peerId}`);
    }

    this._clearSendTimer(peerId);
    const waitMs = retryCount === 0 ? 20000 : 12000;

    const timer = setTimeout(() => {
      this._sendTimers.delete(peerId);
      if (this.channels.get(peerId)?.readyState === 'open') {
        this._processQueue(peerId);
        return;
      }

      const pcNow = this.connections.get(peerId);
      const chNow = this.channels.get(peerId);
      const stillNegotiating =
        chNow?.readyState === 'connecting' ||
        pcNow?.connectionState === 'connecting' ||
        pcNow?.iceConnectionState === 'checking' ||
        pcNow?.iceConnectionState === 'new';

      if (stillNegotiating && negotiateWaits < 5) {
        console.log(`[WebRTC] Still negotiating with ${peerId}, waiting… (${negotiateWaits + 1}/5)`);
        this._armSend(peerId, retryCount, negotiateWaits + 1);
        return;
      }

      if (retryCount < 3) {
        console.log(`[WebRTC] Send retry ${retryCount + 1} for ${peerId}`);
        if (pcNow?.connectionState === 'failed' || pcNow?.connectionState === 'closed') {
          this._closeConnectionForPeer(peerId);
        }
        this._armSend(peerId, retryCount + 1, 0);
        return;
      }

      console.log(`[WebRTC] Direct connect failed for ${peerId}, relay fallback`);
      this._flushQueueToRelay(peerId);
    }, waitMs);

    this._sendTimers.set(peerId, timer);
  }

  _flushQueueToRelay(peerId) {
    const queue = this._fileQueues?.get(peerId);
    if (!queue?.length) return;
    const files = [...queue];
    this._fileQueues.delete(peerId);
    this._sending.delete(peerId);
    this._pendingFiles.delete(peerId);
    this._batchTotals.delete(peerId);
    if (this.onSendFailed) {
      this.onSendFailed(peerId, files[0]?.name || 'files', 'Direct connection failed, trying relay…');
    }
    for (const file of files) this.sendFileRelay(peerId, file);
  }

  setupChannel(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    if (typeof channel.bufferedAmountLowThreshold !== 'undefined') {
      channel.bufferedAmountLowThreshold = LAN_BUFFER_THRESHOLD;
    }
    this.channels.set(peerId, channel);

    channel.onopen = () => {
      console.log(`[WebRTC] Data channel open for ${peerId}`);
      this._sending.delete(peerId);
      this._pendingFiles.delete(peerId);
      this._clearSendTimer(peerId);
      this._processQueue(peerId);
    };
    channel.onclose = () => {
      this.channels.delete(peerId);
      this._sending.delete(peerId);
      const q = this._fileQueues?.get(peerId);
      if (q?.length && !this._pendingFiles.has(peerId)) {
        this._pendingFiles.set(peerId, q[0]);
      }
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
        if (meta.avgMbps) this._adjustFlowControl(peerId, { mbps: meta.avgMbps });
        this._completeSend(peerId, meta.filename);
        if (this._senderWaitingAck) this._senderWaitingAck.delete(peerId);
        this._processRelayQueue(peerId);

      } else if (meta.type === 'cancel') {
        // Clean up receiver state if we were receiving
        this.incomingFiles.delete(peerId);
        if (this._flowState?.has(peerId)) this._flowState.delete(peerId);
        if (this.onProgress) this.onProgress(peerId, meta.filename || 'file', -1, 0, 'receive');

        // Clean up sender state if we were sending
        const sendState = this.activeSends.get(peerId);
        if (sendState) {
          sendState.cancelled = true;
          this.activeSends.delete(peerId);
        }
        this._sending.delete(peerId);
        this._batchTotals.delete(peerId);
        this._pendingFiles.delete(peerId);
        for (const key of [...this._ackFallbackTimers.keys()]) {
          if (key.startsWith(`${peerId}:send:`)) {
            clearTimeout(this._ackFallbackTimers.get(key));
            this._ackFallbackTimers.delete(key);
          }
        }
        if (this.onProgress) this.onProgress(peerId, meta.filename || 'file', -1, 0, 'send');

        // Dequeue and move to the next file in the queues so we never get stuck
        const queue = this._fileQueues?.get(peerId);
        if (queue?.length > 0) {
          const currentFile = queue[0];
          dequeueIfHead(queue, currentFile);
          this._processQueue(peerId);
        }
        const relayQueue = this._relayQueues?.get(peerId);
        if (relayQueue?.length > 0) {
          const currentFile = relayQueue[0];
          dequeueIfHead(relayQueue, currentFile);
          this._processRelayQueue(peerId);
        }
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

  // Force-close a stale WebRTC connection so retry can start fresh
  _closeConnectionForPeer(peerId) {
    const pc = this.connections.get(peerId);
    if (pc) {
      try { pc.close(); } catch (_) {}
      this.connections.delete(peerId);
    }
    const ch = this.channels.get(peerId);
    if (ch && ch.readyState !== 'closed') {
      try { ch.close(); } catch (_) {}
    }
    this.channels.delete(peerId);
    this._pendingCandidates.delete(peerId);
    const t = this._connectionTimeouts.get(peerId);
    if (t) { clearTimeout(t); this._connectionTimeouts.delete(peerId); }
    // Leave file in queue — retry will pick it up
    console.log(`[WebRTC] Closed stale connection for ${peerId}`);
  }

  sendFile(peerId, file, retryCount = 0) {
    if (!file) return;
    const channel = this.channels.get(peerId);

    if (channel?.readyState === 'open') {
      console.log(`[WebRTC] Open channel for ${peerId}, queuing: ${file.name}`);
      this._enqueueFile(peerId, file);
      return;
    }

    if (retryCount === 0) {
      console.log(`[WebRTC] No channel for ${peerId}, establishing…`);
      this._enqueueFile(peerId, file, true);
      this._pendingFiles.set(peerId, file);
      this._armSend(peerId, 0);
      return;
    }

    // Legacy retry path (single-file)
    if (retryCount < 4) {
      if (this.connections.get(peerId)?.connectionState === 'failed') {
        this._closeConnectionForPeer(peerId);
      }
      this.preConnect(peerId);
      this._armSend(peerId, retryCount);
    } else {
      this._flushQueueToRelay(peerId);
    }
  }

  _enqueueFile(peerId, file, deferProcess = false) {
    if (!this._fileQueues) this._fileQueues = new Map();
    if (!this._fileQueues.has(peerId)) this._fileQueues.set(peerId, []);
    const queue = this._fileQueues.get(peerId);
    const { added } = enqueueFile(queue, file);
    if (!added) {
      console.log(`[WebRTC] File "${file.name}" already queued for ${peerId}, skipping duplicate`);
      return;
    }
    if (!deferProcess) this._processQueue(peerId);
  }

  getQueueStatus(peerId) {
    const queue = this._fileQueues?.get(peerId) || [];
    const sending = !!this._sending.get(peerId);
    const remaining = queueRemaining(queue);
    const batchTotal = this._batchTotals.get(peerId) || queue.length;
    return { pending: remaining, sending, total: batchTotal };
  }

  _processQueue(peerId) {
    if (!this._fileQueues) this._fileQueues = new Map();
    const queue = this._fileQueues.get(peerId);
    if (!queue || queue.length === 0) return;

    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') {
      console.log(`[WebRTC] Queue waiting — channel ${channel ? channel.readyState : 'missing'} (${queue.length} file(s))`);
      return;
    }

    if (this._sending.get(peerId)) return;

    const file = queue[0];
    console.log(`[WebRTC] Starting send: ${file.name} (${queue.length} in queue)`);
    this._sending.set(peerId, true);
    this._sendFileDirect(peerId, file);
  }

  _finishDirectSend(peerId, file, fileName) {
    this._sending.delete(peerId);
    const queue = this._fileQueues?.get(peerId);
    if (queue) dequeueIfHead(queue, file);

    if (this.onProgress) this.onProgress(peerId, fileName, 100, file.size, 'send');

    const ackKey = `${peerId}:send:${fileName}`;
    const fallback = setTimeout(() => this._completeSend(peerId, fileName), SEND_ACK_FALLBACK_MS);
    this._ackFallbackTimers.set(ackKey, fallback);

    const channel = this.channels.get(peerId);
    const startNext = () => {
      const left = queue?.length || 0;
      if (left > 0) console.log(`[WebRTC] Pipelining next file (${left} in queue) to ${peerId}`);
      else this._batchTotals.delete(peerId);
      this._processQueue(peerId);
    };

    if (channel?.readyState === 'open' && channel.bufferedAmount > 0) {
      channel.onbufferedamountlow = () => {
        channel.onbufferedamountlow = null;
        startNext();
      };
    } else {
      startNext();
    }
  }

  _sendFileDirect(peerId, file) {
    const channel = this.channels.get(peerId);
    if (!channel || channel.readyState !== 'open') {
      console.warn(`[WebRTC] Channel not open for ${peerId}, will retry on reopen`);
      this._sending.delete(peerId);
      return;
    }

    const fileName = ensureExtension(file.name, file.type);
    const fc = this._flowCtrl?.get(peerId);
    const threshold = Math.min(fc?.threshold || LAN_BUFFER_THRESHOLD, LAN_BUFFER_THRESHOLD_MAX);
    if (channel.bufferedAmountLowThreshold !== undefined) {
      channel.bufferedAmountLowThreshold = threshold;
    }
    const queue = this._fileQueues?.get(peerId) || [];
    const batchTotal = this._batchTotals.get(peerId) || queue.length;
    console.log(`[WebRTC] Direct send to ${peerId}: ${fileName} (${(file.size / 1024 / 1024).toFixed(1)} MB, queue=${queue.length})`);

    const sendState = { cancelled: false };
    this.activeSends.set(peerId, sendState);

    if (this.onTransferStart) {
      this.onTransferStart(peerId, fileName, 'send', { batchTotal, batchRemaining: queue.length });
    }

    channel.send(JSON.stringify({ type: 'header', name: fileName, size: file.size, mimeType: file.type }));
    if (this.onProgress) this.onProgress(peerId, fileName, 0, file.size, 'send');

    // Tiny / empty file — no FileReader needed
    if (file.size === 0) {
      channel.send(JSON.stringify({ type: 'done' }));
      this.activeSends.delete(peerId);
      this._finishDirectSend(peerId, file, fileName);
      return;
    }

    let offset = 0;
    const reader = new FileReader();

    const readNext = () => {
      const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      reader.readAsArrayBuffer(slice);
    };

    const waitThenSend = (buf) => {
      channel.onbufferedamountlow = () => {
        channel.onbufferedamountlow = null;
        sendChunk(buf);
      };
    };

    const sendChunk = (buf) => {
      if (sendState.cancelled) {
        this.activeSends.delete(peerId);
        this._sending.delete(peerId);
        return;
      }

      const lowMark = channel.bufferedAmountLowThreshold ?? threshold;
      if (channel.bufferedAmount > lowMark) {
        waitThenSend(buf);
        return;
      }

      try {
        channel.send(buf);
      } catch (err) {
        if (err.name === 'OperationError') {
          waitThenSend(buf);
          return;
        }
        console.error('[WebRTC] channel.send failed:', err);
        this._sending.delete(peerId);
        this.activeSends.delete(peerId);
        if (this.onSendFailed) this.onSendFailed(peerId, fileName, err.message);
        return;
      }

      offset += buf.byteLength;
      const progress = Math.min((offset / file.size) * 100, 99.9);
      if (this.onProgress) this.onProgress(peerId, fileName, progress, file.size, 'send');

      if (offset >= file.size) {
        channel.send(JSON.stringify({ type: 'done' }));
        this.activeSends.delete(peerId);
        this._finishDirectSend(peerId, file, fileName);
        return;
      }

      readNext();
    };

    const onReadError = (err) => {
      console.error('[WebRTC] FileReader error:', err);
      this._sending.delete(peerId);
      this.activeSends.delete(peerId);
      if (this.onSendFailed) this.onSendFailed(peerId, fileName, 'Could not read file');
    };

    reader.onload = (e) => sendChunk(e.target.result);
    reader.onerror = onReadError;

    readNext();
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
      fc = { threshold: LAN_BUFFER_THRESHOLD, lastMbps: 0, steadySends: 0 };
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
      fc.threshold = Math.min(LAN_BUFFER_THRESHOLD_MAX, fc.threshold * 1.25);
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
      dequeueIfHead(queue, file);
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
        const ackKey = `${peerId}:send:${fileName}`;
        const fallback = setTimeout(() => this._completeSend(peerId, fileName), SEND_ACK_FALLBACK_MS);
        this._ackFallbackTimers.set(ackKey, fallback);
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
    const sendState = this.activeSends.get(peerId);
    if (sendState) sendState.cancelled = true;
    this._sending.delete(peerId);
    this._batchTotals.delete(peerId);
    if (this._fileQueues?.has(peerId)) this._fileQueues.delete(peerId);
    if (this._relayQueues?.has(peerId)) this._relayQueues.delete(peerId);
    if (this._pendingFiles?.has(peerId)) this._pendingFiles.delete(peerId);
    for (const key of [...this._ackFallbackTimers.keys()]) {
      if (key.startsWith(`${peerId}:send:`)) {
        clearTimeout(this._ackFallbackTimers.get(key));
        this._ackFallbackTimers.delete(key);
      }
    }
    // Notify receiver so they don't wait
    const channel = this.channels.get(peerId);
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'cancel', filename: '' }));
    } else {
      this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'cancel', filename: '' }));
    }
    this.activeSends.delete(peerId);
  }

  cancelReceive(peerId) {
    this.incomingFiles.delete(peerId);
    if (this._flowState?.has(peerId)) this._flowState.delete(peerId);
    // Notify sender so they don't keep sending and don't get stuck
    const channel = this.channels.get(peerId);
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'cancel', filename: '' }));
    } else {
      this.signalingClient.sendRelay(peerId, JSON.stringify({ type: 'cancel', filename: '' }));
    }
  }

  // Wake Lock to prevent screen from sleeping during active sessions or transfers
  async _requestWakeLock() {
    if (this.wakeLock) return;
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

  // Dynamic wake lock state updater based on peers presence or active transfers
  _updateWakeLockState() {
    const shouldKeepAwake = this.hasPeers || this.activeTransferCount > 0;
    if (shouldKeepAwake) {
      this._requestWakeLock();
    } else {
      this._releaseWakeLock();
    }
  }

  // Hook called by main.js when peer presence changes
  onPeerPresenceChange(hasPeers) {
    this.hasPeers = hasPeers;
    this._updateWakeLockState();
  }

  // Pause all active transfers (called when app goes to background/screen off)
  pauseTransfers() {
    // Keep signaling alive, transfers proceed via WebRTC or Relay in background
  }

  // Resume all transfers (when app comes to foreground)
  resumeTransfers() {
    this._updateWakeLockState();
  }

  // Track active transfers for wake lock management
  _incrementActiveTransfers() {
    this.activeTransferCount++;
    this._updateWakeLockState();
  }

  _decrementActiveTransfers() {
    if (this.activeTransferCount > 0) {
      this.activeTransferCount--;
      this._updateWakeLockState();
    }
  }

  getActiveTransferCount() {
    return this.activeTransferCount;
  }
}
