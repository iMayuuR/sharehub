// signaling.js

// Fetch public IP — multiple fallbacks for reliability
async function getPublicIp() {
  const apis = [
    'https://api.ipify.org?format=json',
    'https://api.seeip.org/jsonip',
    'https://api.my-ip.io/v2/ip.json'
  ];
  
  for (const api of apis) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(api, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      const ip = data.ip || data.IP || data.origin;
      if (ip) return ip;
    } catch {
      continue;
    }
  }
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
  }

  async connect(roomId) {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const urlParams = new URL(window.location.href).searchParams;
    this._roomId = roomId || urlParams.get('roomId') || urlParams.get('room');

    // Fetch public IP once (cached after first call)
    if (!this._publicIp) {
      this._publicIp = await getPublicIp();
      console.log('[ShareHub] Public IP:', this._publicIp);
    }

    // Build WebSocket URL
    const signalingBase = import.meta.env.VITE_SIGNALING_URL;
    let url;

    if (signalingBase) {
      const base = signalingBase.replace(/^http/, 'ws');
      url = `${base}?peerId=${this.peerId}&publicIp=${encodeURIComponent(this._publicIp)}`;
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      url = `${protocol}//${host}:3000?peerId=${this.peerId}&publicIp=${encodeURIComponent(this._publicIp)}`;
    }

    if (this._roomId) url += `&roomId=${encodeURIComponent(this._roomId)}`;

    console.log('[ShareHub] Connecting to:', url);
    if (this.onConnectionChange) this.onConnectionChange('connecting');

    try {
      this.ws = new WebSocket(url);
    } catch {
      if (this.onConnectionChange) this.onConnectionChange('error');
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[ShareHub] WebSocket connected');
      if (this.onConnectionChange) this.onConnectionChange('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'connected':
            console.log('[ShareHub] Server confirmed. Rooms:', data.rooms);
            break;
          case 'peers-list':
            console.log('[ShareHub] Peers in room:', data.peers);
            if (this.onPeersList) this.onPeersList(data.peers);
            break;
          case 'peer-joined':
            console.log('[ShareHub] Peer joined:', data.peerId);
            if (this.onPeerJoined) this.onPeerJoined(data.peerId);
            break;
          case 'peer-left':
            console.log('[ShareHub] Peer left:', data.peerId);
            if (this.onPeerLeft) this.onPeerLeft(data.peerId);
            break;
          case 'signal':
            if (this.onSignal) this.onSignal(data.from, data.signal);
            break;
          case 'relay':
            if (this.onRelay) this.onRelay(data.from, data.payload);
            break;
          case 'room-joined':
            console.log('[ShareHub] Joined room:', data.roomCode);
            if (this.onRoomJoined) this.onRoomJoined(data.roomCode);
            break;
        }
      } catch(e) {
        console.error('[ShareHub] Parse error:', e);
      }
    };

    this.ws.onerror = (e) => {
      console.error('[ShareHub] WebSocket error');
      if (this.onConnectionChange) this.onConnectionChange('error');
    };

    this.ws.onclose = () => {
      console.log('[ShareHub] WebSocket closed');
      if (this.onConnectionChange) this.onConnectionChange('disconnected');
      if (!this._intentionalClose) this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    this._reconnectTimer = setTimeout(() => this.connect(this._roomId), 3000);
  }

  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) this.ws.close();
  }

  joinRoom(roomCode) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'join-room', roomCode }));
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
