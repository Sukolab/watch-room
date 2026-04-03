const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const MAX_VIEWERS = 5;
const MAX_TOTAL = MAX_VIEWERS + 1;

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(__dirname + '/index.html'));

function buildIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const turnUrls = String(process.env.TURN_URL || '').split(',').map((v) => v.trim()).filter(Boolean);
  const turnUsername = String(process.env.TURN_USERNAME || '').trim();
  const turnCredential = String(process.env.TURN_CREDENTIAL || '').trim();

  turnUrls.forEach((url) => {
    const entry = { urls: url };
    if (turnUsername) entry.username = turnUsername;
    if (turnCredential) entry.credential = turnCredential;
    servers.push(entry);
  });

  return servers;
}

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.WATCH_ROOM_CONFIG = ${JSON.stringify({ iceServers: buildIceServers(), maxViewers: MAX_VIEWERS, maxTotal: MAX_TOTAL })};`);
});

const rooms = new Map();

function sanitizeRoomId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function ensureRoom(roomId, password = '') {
  let room = getRoom(roomId);
  if (!room) {
    room = { roomId, password: String(password || ''), members: [], createdAt: Date.now() };
    rooms.set(roomId, room);
  }
  return room;
}

function publicRooms() {
  return Array.from(rooms.values())
    .filter((room) => room.members.length > 0)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((room) => ({
      roomId: room.roomId,
      count: room.members.length,
      locked: !!room.password,
      hasHost: room.members.some((m) => m.role === 'host'),
      viewers: room.members.filter((m) => m.role === 'viewer').length,
      maxViewers: MAX_VIEWERS,
    }));
}

function emitRoomList() {
  io.emit('room-list', { rooms: publicRooms() });
}

function emitPeerCount(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  room.members.forEach((m) => io.to(m.id).emit('peer-count', { count: room.members.length }));
}

function hostExists(room) {
  return room.members.some((m) => m.role === 'host');
}

function viewerCount(room) {
  return room.members.filter((m) => m.role === 'viewer').length;
}

io.on('connection', (socket) => {
  socket.emit('room-list', { rooms: publicRooms() });

  socket.on('get-room-list', () => {
    socket.emit('room-list', { rooms: publicRooms() });
  });

  socket.on('join-room', ({ roomId, displayName, requestedRole, password }) => {
    roomId = sanitizeRoomId(roomId);
    displayName = String(displayName || 'Guest').trim() || 'Guest';
    requestedRole = requestedRole === 'host' ? 'host' : 'viewer';
    password = String(password || '');

    if (!roomId) return socket.emit('room-error', 'Missing room code.');

    let room = getRoom(roomId);
    const isCreating = !room;
    if (!room) room = ensureRoom(roomId, password);

    if (room.password && room.password !== password) return socket.emit('room-error', 'Wrong room password.');
    if (!room.password && isCreating && password) room.password = password;

    if (requestedRole === 'host' && hostExists(room)) {
      return socket.emit('room-error', 'This room already has a host. Join as viewer instead.');
    }
    if (requestedRole === 'viewer' && viewerCount(room) >= MAX_VIEWERS) {
      return socket.emit('room-error', `Viewer limit reached. Max ${MAX_VIEWERS} viewers.`);
    }
    if (room.members.length >= MAX_TOTAL) {
      return socket.emit('room-error', `Room is full. Max ${MAX_TOTAL} people total.`);
    }

    const role = requestedRole;

    socket.data.roomId = roomId;
    socket.data.displayName = displayName;
    socket.data.role = role;

    room.members.push({ id: socket.id, role, displayName });
    socket.join(roomId);

    const peers = room.members
      .filter((m) => m.id !== socket.id)
      .map((m) => ({ id: m.id, role: m.role, displayName: m.displayName }));

    socket.emit('joined-room', {
      roomId,
      peers,
      count: room.members.length,
      isHost: role === 'host',
      locked: !!room.password,
      maxViewers: MAX_VIEWERS,
    });

    peers.forEach((peer) => {
      io.to(peer.id).emit('peer-joined', {
        socketId: socket.id,
        displayName,
        role,
        count: room.members.length,
      });
    });

    emitPeerCount(roomId);
    emitRoomList();
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media-state', ({ roomId, screenActive, camActive }) => {
    roomId = sanitizeRoomId(roomId);
    const room = getRoom(roomId);
    if (!room) return;
    socket.to(roomId).emit('media-state', {
      from: socket.id,
      screenActive: !!screenActive,
      camActive: !!camActive,
    });
  });

  socket.on('disconnect', () => {
    const roomId = sanitizeRoomId(socket.data.roomId);
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;

    room.members = room.members.filter((m) => m.id !== socket.id);

    if (room.members.length === 0) {
      rooms.delete(roomId);
    } else {
      room.members.forEach((m) => io.to(m.id).emit('peer-left', {
        socketId: socket.id,
        count: room.members.length,
      }));
      emitPeerCount(roomId);
    }

    emitRoomList();
  });
});

server.listen(PORT, () => console.log('Watch Room multi-viewer running on port ' + PORT));
