const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Keepalive endpoint — pinged by frontend to prevent Render free tier sleep
app.get('/health', (req, res) => res.status(200).send('ok'));

// Store connected peers: Map<string, { ws, rooms, peerId }>
const peers = new Map();

function getRoomForIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();

  // Normalize IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');

  // Group all local/private IPs into one room for LAN discovery
  if (ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return 'local-lan';
  }
  return ip;
}

// Helper to check if two sets share at least one element
function intersects(setA, setB) {
  for (const elem of setA) if (setB.has(elem)) return true;
  return false;
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const peerId = urlParams.get('peerId');
  const explicitRoomId = urlParams.get('roomId');

  if (!peerId) {
    ws.close(1008, 'Peer ID is required');
    return;
  }

  // A peer belongs to multiple rooms simultaneously:
  // 1. IP-based room (auto-discovery for same public IP / LAN)
  // 2. Their own peerId (so others can target them directly)
  // 3. Any explicit roomId from URL (QR scan or room code link)
  const rooms = new Set();
  rooms.add(getRoomForIp(req));
  rooms.add(peerId);
  if (explicitRoomId) rooms.add(explicitRoomId);

  peers.set(peerId, { ws, rooms, peerId });

  // Send the newly joined peer the list of existing peers in shared rooms
  const peersInRoom = Array.from(peers.values())
    .filter(p => p.peerId !== peerId && intersects(p.rooms, rooms))
    .map(p => p.peerId);

  ws.send(JSON.stringify({ type: 'peers-list', peers: peersInRoom }));

  // Broadcast to other peers in shared rooms that a new peer joined
  peers.forEach(p => {
    if (p.peerId !== peerId && intersects(p.rooms, rooms)) {
      p.ws.send(JSON.stringify({ type: 'peer-joined', peerId }));
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Dynamic room joining — peer sends a room code to join after initial connection
      if (data.type === 'join-room' && data.roomCode) {
        const roomCode = data.roomCode.toUpperCase().trim();
        rooms.add(roomCode);

        // Find peers already in this room and exchange discovery
        peers.forEach(p => {
          if (p.peerId !== peerId && p.rooms.has(roomCode)) {
            // Tell the joiner about existing peer
            ws.send(JSON.stringify({ type: 'peer-joined', peerId: p.peerId }));
            // Tell existing peer about the joiner
            p.ws.send(JSON.stringify({ type: 'peer-joined', peerId }));
          }
        });

        ws.send(JSON.stringify({ type: 'room-joined', roomCode }));
        return;
      }

      // Relay signaling messages (SDP/ICE) to a specific target peer
      if (data.type === 'signal') {
        const target = peers.get(data.to);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ type: 'signal', from: peerId, signal: data.signal }));
        }
      }

      // Relay fallback for file data when WebRTC fails
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
