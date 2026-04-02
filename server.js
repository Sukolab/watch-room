const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(__dirname + '/index.html'));

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

    if (room.members.length >= 8) return socket.emit('room-full');
    if (room.password && room.password !== password) return socket.emit('room-error', 'Wrong room password.');
    if (!room.password && isCreating && password) room.password = password;

    let role = requestedRole;
    if (role === 'host' && hostExists(room)) role = 'viewer';

    socket.data.roomId = roomId;
    socket.data.displayName = displayName;
    socket.data.role = role;

    room.members.push({ id: socket.id, role, displayName });
    socket.join(roomId);

    const peers = room.members.filter((m) => m.id !== socket.id).map((m) => ({ id: m.id, role: m.role }));
    socket.emit('joined-room', {
      roomId,
      peers,
      count: room.members.length,
      isHost: role === 'host',
      locked: !!room.password,
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
      room.members.forEach((m) => io.to(m.id).emit('peer-left', { count: room.members.length }));
      emitPeerCount(roomId);
    }

    emitRoomList();
  });
});

server.listen(PORT, () => console.log('Watch Room v3 running on port ' + PORT));
