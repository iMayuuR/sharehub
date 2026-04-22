const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => {
  res.send('<h1>ShareHub Signaling Server 🚀</h1>');
});

app.get('/health', (req, res) => {
  const peerInfo = Array.from(peers.entries()).map(([id, p]) => ({
    peerId: id.substring(0, 12) + '...',
    rooms: Array.from(p.rooms).filter(r => r !== id) // Hide peerId room for clarity
  }));
  res.json({ status: 'ok', peers: peers.size, peerDetails: peerInfo, uptime: Math.floor(process.uptime()) });
});

// Store connected peers
const peers = new Map();

function getClientIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  return ip;
}

function intersects(setA, setB) {
  for (const elem of setA) if (setB.has(elem)) return true;
  return false;
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const peerId = urlParams.get('peerId');
  const explicitRoomId = urlParams.get('roomId');
  const clientPublicIp = urlParams.get('publicIp');

  if (!peerId) {
    ws.close(1008, 'Peer ID is required');
    return;
  }

  const rooms = new Set();

  // 1. Get real client IP
  let serverIp = getClientIp(req);
  
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:1.2.3.4 -> 1.2.3.4)
  if (serverIp.includes(':') && serverIp.includes('.')) {
    const parts = serverIp.split(':');
    serverIp = parts[parts.length - 1];
  }
  
  // Group by Server-detected IP
  rooms.add(`ip-${serverIp}`);

  // Group by Client-reported IP (if different)
  if (clientPublicIp && clientPublicIp !== 'unknown' && clientPublicIp !== serverIp) {
    rooms.add(`ip-${clientPublicIp}`);
  }

  // Debug: Server seeing peer in these network rooms
  // console.log(`[Discovery] Peer ${peerId} grouped in:`, Array.from(rooms));

  // 3. Own peerId as room (for direct signaling)
  rooms.add(peerId);

  // 4. Explicit roomId
  if (explicitRoomId) rooms.add(explicitRoomId.toUpperCase().trim());

  peers.set(peerId, { ws, rooms, peerId });

  console.log(`[+] ${peerId.substring(0, 8)} connected | IP: ${serverIp} | clientIP: ${clientPublicIp} | rooms: ${Array.from(rooms).filter(r => r !== peerId).join(', ')}`);

  // Send connection confirmation with rooms (so frontend can log)
  ws.send(JSON.stringify({ type: 'connected', peerId, rooms: Array.from(rooms).filter(r => r !== peerId) }));

  // Send existing peers that share any room
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
        console.log(`[R] ${peerId.substring(0, 8)} joined room: ${roomCode}`);
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
      console.error('Message parse error:', e);
    }
  });

  ws.on('close', () => {
    const disconnectedRooms = peers.get(peerId)?.rooms || new Set();
    peers.delete(peerId);
    console.log(`[-] ${peerId.substring(0, 8)} disconnected`);

    // Immediately broadcast to all peers in shared rooms
    peers.forEach(p => {
      if (intersects(p.rooms, disconnectedRooms)) {
        p.ws.send(JSON.stringify({ type: 'peer-left', peerId }));
      }
    });
  });

  // Prevent Render timeout
  const keepAlive = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(keepAlive);
  }, 25000);

  ws.on('close', () => clearInterval(keepAlive));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server on port ${PORT}`);
});
