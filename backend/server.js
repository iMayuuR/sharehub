const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// CORS — allow the Vercel frontend to hit HTTP endpoints
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => {
  res.send('<h1>ShareHub Signaling Server is Running 🚀</h1>');
});

app.get('/health', (req, res) => {
  const peerInfo = Array.from(peers.entries()).map(([id, p]) => ({
    peerId: id.substring(0, 8) + '...',
    rooms: Array.from(p.rooms)
  }));
  res.json({ status: 'ok', peers: peers.size, peerDetails: peerInfo, uptime: process.uptime() });
});

// Store connected peers: Map<string, { ws, rooms, peerId }>
const peers = new Map();

function getRoomForIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');

  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return 'local-lan';
  }
  return `ip-${ip}`;
}

function intersects(setA, setB) {
  for (const elem of setA) if (setB.has(elem)) return true;
  return false;
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const peerId = urlParams.get('peerId');
  const explicitRoomId = urlParams.get('roomId');
  const clientPublicIp = urlParams.get('publicIp'); // Client-reported public IP for discovery

  if (!peerId) {
    ws.close(1008, 'Peer ID is required');
    return;
  }

  const rooms = new Set();

  // 1. Server-detected IP room (x-forwarded-for)
  rooms.add(getRoomForIp(req));

  // 2. Client-reported public IP room (from ipify API — more reliable across proxies)
  if (clientPublicIp && clientPublicIp !== 'unknown') {
    rooms.add(`ip-${clientPublicIp}`);
  }

  // 3. Own peerId as room (for direct targeting)
  rooms.add(peerId);

  // 4. Explicit roomId from URL (QR scan / room code link)
  if (explicitRoomId) rooms.add(explicitRoomId.toUpperCase().trim());

  peers.set(peerId, { ws, rooms, peerId });

  // Send connection confirmation
  ws.send(JSON.stringify({ type: 'connected', peerId, rooms: Array.from(rooms) }));

  // Send existing peers in shared rooms
  const peersInRoom = Array.from(peers.values())
    .filter(p => p.peerId !== peerId && intersects(p.rooms, rooms))
    .map(p => p.peerId);

  ws.send(JSON.stringify({ type: 'peers-list', peers: peersInRoom }));

  // Broadcast new peer to others in shared rooms
  peers.forEach(p => {
    if (p.peerId !== peerId && intersects(p.rooms, rooms)) {
      p.ws.send(JSON.stringify({ type: 'peer-joined', peerId }));
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join-room' && data.roomCode) {
        const roomCode = data.roomCode.toUpperCase().trim();
        rooms.add(roomCode);

        peers.forEach(p => {
          if (p.peerId !== peerId && p.rooms.has(roomCode)) {
            ws.send(JSON.stringify({ type: 'peer-joined', peerId: p.peerId }));
            p.ws.send(JSON.stringify({ type: 'peer-joined', peerId }));
          }
        });

        ws.send(JSON.stringify({ type: 'room-joined', roomCode }));
        return;
      }

      if (data.type === 'signal') {
        const target = peers.get(data.to);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ type: 'signal', from: peerId, signal: data.signal }));
        }
      }

      if (data.type === 'relay') {
        const target = peers.get(data.to);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ type: 'relay', from: peerId, payload: data.payload }));
        }
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    const disconnectedRooms = peers.get(peerId)?.rooms || new Set();
    peers.delete(peerId);

    peers.forEach(p => {
      if (intersects(p.rooms, disconnectedRooms)) {
        p.ws.send(JSON.stringify({ type: 'peer-left', peerId }));
      }
    });
  });

  // Prevent connection timeout on Render
  const keepAlive = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(keepAlive);
  }, 30000);

  ws.on('close', () => clearInterval(keepAlive));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
