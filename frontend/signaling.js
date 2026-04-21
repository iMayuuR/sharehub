// signaling.js
export class SignalingClient {
  constructor(peerId, onPeerJoined, onPeerLeft, onPeersList, onSignal, onRelay) {
    this.peerId = peerId;
    this.onPeerJoined = onPeerJoined;
    this.onPeerLeft = onPeerLeft;
    this.onPeersList = onPeersList;
    this.onSignal = onSignal;
    this.onRelay = onRelay;
    this.ws = null;
  }

  connect() {
    const urlParams = new URL(window.location.href).searchParams;
    const roomId = urlParams.get('roomId');

    // Production: use VITE_SIGNALING_URL env variable (set during Vercel build)
    // Local dev: auto-detect hostname on port 3000
    const signalingBase = import.meta.env.VITE_SIGNALING_URL;
    let url;

    if (signalingBase) {
      // Production — Render backend (e.g., wss://sharehub-signaling.onrender.com)
      const base = signalingBase.replace(/^http/, 'ws');
      url = `${base}?peerId=${this.peerId}`;
    } else {
      // Local development — same host, port 3000
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      url = `${protocol}//${host}:3000?peerId=${this.peerId}`;
    }

    if (roomId) url += `&roomId=${roomId}`;
    
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {};

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
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
        }
      } catch(e) {
        console.error('Error parsing signaling message', e);
      }
    };

    this.ws.onclose = () => {
      // Reconnect on disconnect
      setTimeout(() => this.connect(), 3000); // Retry logic
    };
  }

  sendSignal(toId, signalData) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'signal',
        to: toId,
        signal: signalData
      }));
    }
  }

  sendRelay(toId, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'relay',
        to: toId,
        payload: payload
      }));
    }
  }
}
