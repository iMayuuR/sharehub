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

// A phone that backgrounds for a moment, or a Wi-Fi blip, closes the socket and
// reopens it seconds later. Announcing that as a departure made devices vanish
// from everyone's radar and pop back — so hold the news for a grace period and
// say nothing at all if they come straight back.
const PEER_GRACE_MS = 8000;
const pendingDepartures = new Map();

function cancelDeparture(peerId) {
  const timer = pendingDepartures.get(peerId);
  if (!timer) return false;
  clearTimeout(timer);
  pendingDepartures.delete(peerId);
  return true;
}

function getClientIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  return ip;
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
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
  
  // Determine the network IP to use for grouping
  // Prefer client-reported public IP if available (same for all devices behind NAT)
  // Fallback to server-detected IP (useful for self-hosted or when client IP detection fails)
  let networkIp = serverIp;
  if (clientPublicIp && clientPublicIp !== 'unknown') {
    networkIp = clientPublicIp;
  }

  // Both the address we observe and the one the client reports. A client whose
  // public-IP lookup was blocked, or answered by a different provider, still
  // shares the server-observed room with everyone behind the same NAT.
  rooms.add(`ip-${networkIp}`);
  if (serverIp && serverIp !== 'unknown') rooms.add(`ip-${serverIp}`);

  // Differing addresses mean this device leaves the network by another route —
  // a VPN or a proxy — so automatic discovery cannot match it up. The client
  // uses this to point the user at a Room Code instead of waiting forever.
  const routedElsewhere = Boolean(
    clientPublicIp && clientPublicIp !== 'unknown' && serverIp !== 'unknown' && clientPublicIp !== serverIp
  );

  // Debug: Server seeing peer in these network rooms
  // console.log(`[Discovery] Peer ${peerId} grouped in:`, Array.from(rooms));

  // 3. Own peerId as room (for direct signaling)
  rooms.add(peerId);

  // 4. Explicit roomId
  if (explicitRoomId) rooms.add(explicitRoomId.toUpperCase().trim());

  // Same device reconnecting: drop the stale socket and keep the departure quiet.
  const returning = cancelDeparture(peerId);
  const previous = peers.get(peerId);
  if (previous && previous.ws !== ws) {
    try { previous.ws.close(4000, 'Replaced by a newer connection'); } catch {}
  }

  peers.set(peerId, { ws, rooms, peerId });

  console.log(`[+] ${peerId.substring(0, 8)} connected | serverIP: ${serverIp} | clientIP: ${clientPublicIp} | networkIP: ${networkIp} | rooms: ${Array.from(rooms).filter(r => r !== peerId).join(', ')}`);

  // Send connection confirmation with rooms (so frontend can log)
  ws.send(JSON.stringify({
    type: 'connected',
    peerId,
    rooms: Array.from(rooms).filter(r => r !== peerId),
    routedElsewhere,
  }));

  // Send existing peers that share any room
  const peersInRoom = Array.from(peers.values())
    .filter(p => p.peerId !== peerId && intersects(p.rooms, rooms))
    .map(p => p.peerId);

  ws.send(JSON.stringify({ type: 'peers-list', peers: peersInRoom }));

  // A device that never left does not need announcing again.
  if (!returning) {
    peers.forEach(p => {
      if (p.peerId !== peerId && intersects(p.rooms, rooms)) {
        send(p.ws, { type: 'peer-joined', peerId });
      }
    });
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join-room' && data.roomCode) {
        const roomCode = data.roomCode.toUpperCase().trim();
        rooms.add(roomCode);

        peers.forEach(p => {
          if (p.peerId !== peerId && p.rooms.has(roomCode)) {
            send(ws, { type: 'peer-joined', peerId: p.peerId });
            send(p.ws, { type: 'peer-joined', peerId });
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
    // Only the socket that is still the current one for this peer counts.
    if (peers.get(peerId)?.ws !== ws) return;

    const departedRooms = peers.get(peerId)?.rooms || new Set();
    peers.delete(peerId);
    console.log(`[-] ${peerId.substring(0, 8)} dropped, holding ${PEER_GRACE_MS}ms`);

    pendingDepartures.set(peerId, setTimeout(() => {
      pendingDepartures.delete(peerId);
      if (peers.has(peerId)) return; // came back on another socket
      console.log(`[-] ${peerId.substring(0, 8)} gone`);
      peers.forEach(p => {
        if (intersects(p.rooms, departedRooms)) send(p.ws, { type: 'peer-left', peerId });
      });
    }, PEER_GRACE_MS));
  });

  // Prevent Render timeout
  const keepAlive = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(keepAlive);
  }, 25000);

  ws.on('close', () => clearInterval(keepAlive));
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Signaling server on port ${PORT}`);
});
