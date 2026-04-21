const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store connected peers: Map<string, WebSocket>
// Since we want to support "Rooms" based on IP or specific ID, we'll store peers with extra metadata
const peers = new Map(); 

function getRoomForIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  
  // Normalize IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  
  // If it's a local network IP, standard web WebRTC will bridge them anyway,
  // so group all local clients into one "local-lan" room for easiest discovery.
  if (ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return 'local-lan';
  }
  return ip;
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const peerId = urlParams.get('peerId');
  const explicitRoomId = urlParams.get('roomId');
  
  if (!peerId) {
    ws.close(1008, 'Peer ID is required');
    return;
  }

  // A peer can belong to multiple rooms simultaneously:
  // 1. Their IP-based room (for auto-discovery on LAN or same IP)
  // 2. Their own explicit peerId (so others can directly target them via QR)
  // 3. Any explicit roomId passed in the URL
  const rooms = new Set();
  rooms.add(getRoomForIp(req));
  rooms.add(peerId);
  if (explicitRoomId) rooms.add(explicitRoomId);

  // Store the peer
  peers.set(peerId, { ws, rooms, peerId });



  // Helper to check if two sets intersect
  const intersects = (setA, setB) => {
    for (let elem of setA) if (setB.has(elem)) return true;
    return false;
  };

  // Find other peers sharing at least one room
  const peersInRoom = Array.from(peers.values())
    .filter(p => p.peerId !== peerId && intersects(p.rooms, rooms))
    .map(p => p.peerId);

  // Send the newly joined peer the list of existing peers
  ws.send(JSON.stringify({
    type: 'peers-list',
    peers: peersInRoom
  }));

  // Broadcast to other peers in shared rooms that a new peer joined
  peers.forEach(p => {
    if (p.peerId !== peerId && intersects(p.rooms, rooms)) {
      p.ws.send(JSON.stringify({
        type: 'peer-joined',
        peerId: peerId
      }));
    }
  });

  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Relay signaling messages to the specific target peer
      if (data.type === 'signal') {
        const targetPeerId = data.to;
        const targetPeer = peers.get(targetPeerId);
        
        if (targetPeer && targetPeer.ws.readyState === 1) { // 1 is OPEN
          targetPeer.ws.send(JSON.stringify({
            type: 'signal',
            from: peerId,
            signal: data.signal
          }));
        }
      }
      
      // Handle Relay Fallback
      if (data.type === 'relay') {
        const targetPeerId = data.to;
        const targetPeer = peers.get(targetPeerId);
        
        if (targetPeer && targetPeer.ws.readyState === 1) {
          targetPeer.ws.send(JSON.stringify({
            type: 'relay',
            from: peerId,
            payload: data.payload
          }));
        }
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    const disconnectedPeerRooms = peers.get(peerId)?.rooms || new Set();
    peers.delete(peerId);
    
    // Broadcast peer leave to anyone who shared a room
    peers.forEach(p => {
      if (intersects(p.rooms, disconnectedPeerRooms)) {
        p.ws.send(JSON.stringify({
          type: 'peer-left',
          peerId: peerId
        }));
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
