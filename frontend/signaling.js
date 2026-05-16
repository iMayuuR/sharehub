// signaling.js - Enhanced logging for debugging

// Cache public IP for 1 hour to avoid repeated fetches
let _cachedPublicIp = null;
let _cacheTimestamp = 0;
const CACHE_DURATION_MS = 3600000; // 1 hour

async function getPublicIp() {
  // Return cached IP if still valid
  if (_cachedPublicIp && (Date.now() - _cacheTimestamp) < CACHE_DURATION_MS) {
    console.log(`[Signaling] Using cached public IP: ${_cachedPublicIp}`);
    return _cachedPublicIp;
  }

  console.log('[Signaling] Fetching public IP...');
  const apis = [
    'https://api4.ipify.org?format=json', // Force IPv4 for better NAT matching
    'https://api.ipify.org?format=json',
    'https://api.seeip.org/jsonip'
  ];

  for (const api of apis) {
    try {
      const controller = new AbortController();
      // Reduced timeout for faster failure
      const timeout = setTimeout(() => controller.abort(), 500);
      const res = await fetch(api, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      const ip = data.ip || data.IP || data.origin;
      if (ip) {
        _cachedPublicIp = ip;
        _cacheTimestamp = Date.now();
        console.log(`[Signaling] Public IP fetched: ${ip}`);
        return ip;
      }
    } catch (err) {
      console.warn(`[Signaling] Failed to fetch IP from ${api}:`, err.message);
      continue;
    }
  }
  console.warn('[Signaling] Could not fetch public IP, using unknown');
  return 'unknown';
}

export class SignalingClient {
  constructor(peerId, onPeerJoined, onPeerLeft, onPeersList, onSignal, onRelay) {
    this.peerId = peerId;
    this.onPeerJoined = onPeerJoined;
    this.onPeerLeft = onPeerLeft;
    this.onPeersList = onPeersList;
    this.onSignal = onSignal;
    this.onRelay = onRelay;
    this.onRoomJoined = null;
    this.onConnectionChange = null;
    this.ws = null;
    this._roomId = null;
    this._reconnectTimer = null;
    this._intentionalClose = false;
    this._publicIp = null;
    this._reconnectAttempts = 0;
  }

  async connect(roomId) {
    console.log('[Signaling] Connecting to signaling server...');
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const urlParams = new URL(window.location.href).searchParams;
    this._roomId = roomId || urlParams.get('roomId') || urlParams.get('room');

    if (!this._publicIp) {
      this._publicIp = await getPublicIp();
    }

    const signalingBase = import.meta.env.VITE_SIGNALING_URL;
    let url;

    if (signalingBase) {
      const base = signalingBase.replace(/^http/, 'ws');
      url = `${base}?peerId=${this.peerId}&publicIp=${encodeURIComponent(this._publicIp)}`;
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      url = `${protocol}//${host}:3002?peerId=${this.peerId}&publicIp=${encodeURIComponent(this._publicIp)}`;
    }

    if (this._roomId) url += `&roomId=${encodeURIComponent(this._roomId)}`;

    // Auto-join last used room for "Same Network" feel
    const lastRoom = localStorage.getItem('sharehub_last_room');
    if (lastRoom && !this._roomId) {
      url += `&roomId=${encodeURIComponent(lastRoom)}`;
    }

    console.log(`[Signaling] Connecting to URL: ${url}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[Signaling] Failed to create WebSocket:', err);
      if (this.onConnectionChange) this.onConnectionChange('error');
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[Signaling] WebSocket connected');
      if (this.onConnectionChange) this.onConnectionChange('connected');
      // Reset reconnect attempts on successful connection
      this._reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        //console.log('[Signaling] Received message:', data.type);
        switch (data.type) {
          case 'connected':
            console.log('[Signaling] Received connected message');
            break;
          case 'peers-list':
            console.log(`[Signaling] Received peers list: ${data.peers.length} peers`);
            if (this.onPeersList) this.onPeersList(data.peers);
            break;
          case 'peer-joined':
            console.log(`[Signaling] Peer joined: ${data.peerId}`);
            if (this.onPeerJoined) this.onPeerJoined(data.peerId);
            break;
          case 'peer-left':
            console.log(`[Signaling] Peer left: ${data.peerId}`);
            if (this.onPeerLeft) this.onPeerLeft(data.peerId);
            break;
          case 'signal':
            //console.log(`[Signaling] Signal received from: ${data.from}`);
            if (this.onSignal) this.onSignal(data.from, data.signal);
            break;
          case 'relay':
            //console.log(`[Signaling] Relay received from: ${data.from}`);
            if (this.onRelay) this.onRelay(data.from, data.payload);
            break;
          case 'room-joined':
            console.log(`[Signaling] Joined room: ${data.roomCode}`);
            if (this.onRoomJoined) this.onRoomJoined(data.roomCode);
            break;
        }
      } catch (err) {
        console.error('[Signaling] Error parsing WebSocket message:', err);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[Signaling] WebSocket error:', err);
      if (this.onConnectionChange) this.onConnectionChange('error');
    };

    this.ws.onclose = (event) => {
      console.log(`[Signaling] WebSocket closed: code=${event.code}, reason=${event.reason}`);
      if (this.onConnectionChange) this.onConnectionChange('disconnected');
      if (!this._intentionalClose) this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    // Exponential backoff: start at 500ms, max 5 seconds
    const delay = Math.min(5000, 500 * (2 ** this._reconnectAttempts));
    this._reconnectTimer = setTimeout(() => this.connect(this._roomId), delay);
    this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
  }

  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) this.ws.close();
  }

  joinRoom(roomCode) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const code = roomCode.toUpperCase().trim();
      localStorage.setItem('sharehub_last_room', code);
      this.ws.send(JSON.stringify({ type: 'join-room', roomCode: code }));
    }
  }

  sendSignal(toId, signalData) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', to: toId, signal: signalData }));
    }
  }

  sendRelay(toId, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'relay', to: toId, payload }));
    }
  }
}
