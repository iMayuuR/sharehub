// signaling.js

async function getPublicIp() {
  const apis = [
    'https://api4.ipify.org?format=json', // Force IPv4 for better NAT matching
    'https://api.ipify.org?format=json',
    'https://api.seeip.org/jsonip'
  ];
  for (const api of apis) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(api, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      const ip = data.ip || data.IP || data.origin;
      if (ip) return ip;
    } catch { continue; }
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
      url = `${protocol}//${host}:3000?peerId=${this.peerId}&publicIp=${encodeURIComponent(this._publicIp)}`;
    }

    if (this._roomId) url += `&roomId=${encodeURIComponent(this._roomId)}`;
    
    // Auto-join last used room for "Same Network" feel
    const lastRoom = localStorage.getItem('sharehub_last_room');
    if (lastRoom && !this._roomId) {
      url += `&roomId=${encodeURIComponent(lastRoom)}`;
    }

    try {
      this.ws = new WebSocket(url);
    } catch {
      if (this.onConnectionChange) this.onConnectionChange('error');
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      if (this.onConnectionChange) this.onConnectionChange('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'connected': break;
          case 'peers-list':
            if (this.onPeersList) this.onPeersList(data.peers);
            break;
          case 'peer-joined':
            if (this.onPeerJoined) this.onPeerJoined(data.peerId);
            break;
          case 'peer-left':
            if (this.onPeerLeft) this.onPeerLeft(data.peerId);
            break;
          case 'signal':
            if (this.onSignal) this.onSignal(data.from, data.signal);
            break;
          case 'relay':
            if (this.onRelay) this.onRelay(data.from, data.payload);
            break;
          case 'room-joined':
            if (this.onRoomJoined) this.onRoomJoined(data.roomCode);
            break;
        }
      } catch {}
    };

    this.ws.onerror = () => {
      if (this.onConnectionChange) this.onConnectionChange('error');
    };

    this.ws.onclose = () => {
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
