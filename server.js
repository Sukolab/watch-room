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
    room = { roomId, password: String(password || ''), members: [], createdAt: Date.now(), chat: [] };
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

  socket.on('join-room', ({ roomId, displayName, requestedRole, password, browser }) => {
    roomId = sanitizeRoomId(roomId);
    displayName = String(displayName || 'Guest').trim() || 'Guest';
    requestedRole = requestedRole === 'host' ? 'host' : 'viewer';
    password = String(password || '');
    browser = browser && typeof browser === 'object' ? browser : {};

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

    room.members.push({ id: socket.id, role, displayName, browser });
    if (role === 'host') room.hostId = socket.id;
    socket.join(roomId);

    const peers = room.members
      .filter((m) => m.id !== socket.id)
      .map((m) => ({ id: m.id, role: m.role, displayName: m.displayName, browser: m.browser || null }));

    socket.emit('joined-room', {
      roomId,
      peers,
      count: room.members.length,
      isHost: role === 'host',
      locked: !!room.password,
      maxViewers: MAX_VIEWERS,
      mediaState: { screenActive: !!room.screenActive, camActive: !!room.camActive, hostId: room.hostId || null },
      participants: room.members.map((m) => ({ id: m.id, role: m.role, displayName: m.displayName, browser: m.browser || null })),
      chat: room.chat || [],
    });

    peers.forEach((peer) => {
      io.to(peer.id).emit('peer-joined', {
        socketId: socket.id,
        displayName,
        role,
        browser: browser || null,
        count: room.members.length,
      });
    });

    emitPeerCount(roomId);
    io.to(roomId).emit('room-state', {
      participants: room.members.map((m) => ({ id: m.id, role: m.role, displayName: m.displayName, browser: m.browser || null })),
      mediaState: { screenActive: !!room.screenActive, camActive: !!room.camActive, hostId: room.hostId || null }
    });
    if (room.screenActive || room.camActive) {
      const host = room.members.find((m) => m.role === 'host');
      if (host) io.to(host.id).emit('sync-media-request', { targetId: socket.id, screenActive: !!room.screenActive, camActive: !!room.camActive });
    }
    emitRoomList();
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });


  socket.on('chat-message', ({ roomId, text }) => {
    roomId = sanitizeRoomId(roomId);
    const room = getRoom(roomId);
    if (!room) return;
    const member = room.members.find((m) => m.id === socket.id);
    if (!member) return;
    text = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    if (!text) return;
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: socket.id,
      name: member.displayName || 'Guest',
      role: member.role || 'viewer',
      text,
      ts: Date.now(),
    };
    room.chat.push(message);
    if (room.chat.length > 100) room.chat = room.chat.slice(-100);
    io.to(roomId).emit('chat-message', message);
  });

  socket.on('request-media-sync', ({ roomId, targetId, reason, preferCodec, republishScreen }) => {
    roomId = sanitizeRoomId(roomId);
    const room = getRoom(roomId);
    if (!room || !room.hostId) return;
    if (targetId && socket.id !== targetId) return;
    if (room.members.some((m) => m.id === socket.id)) {
      io.to(room.hostId).emit('sync-media-request', {
        targetId: socket.id,
        screenActive: !!room.screenActive,
        camActive: !!room.camActive,
        reason: reason || 'viewer-requested',
        preferCodec: typeof preferCodec === 'string' ? preferCodec : 'default',
        republishScreen: !!republishScreen
      });
    }
  });

  socket.on('media-state', ({ roomId, screenActive, camActive }) => {
    roomId = sanitizeRoomId(roomId);
    const room = getRoom(roomId);
    if (!room) return;
    if (room.hostId === socket.id) {
      room.screenActive = !!screenActive;
      room.camActive = !!camActive;
    }
    io.to(roomId).emit('media-state', {
      from: socket.id,
      screenActive: !!screenActive,
      camActive: !!camActive,
    });
    io.to(roomId).emit('room-state', {
      participants: room.members.map((m) => ({ id: m.id, role: m.role, displayName: m.displayName, browser: m.browser || null })),
      mediaState: { screenActive: !!room.screenActive, camActive: !!room.camActive, hostId: room.hostId || null }
    });
    emitRoomList();
  });

  socket.on('leave-room', () => {
    const roomId = sanitizeRoomId(socket.data.roomId);
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;

    room.members = room.members.filter((m) => m.id !== socket.id);
    if (room.hostId === socket.id) {
      room.hostId = null;
      room.screenActive = false;
      room.camActive = false;
    }
    socket.leave(roomId);
    socket.data.roomId = '';
    socket.data.displayName = '';
    socket.data.role = '';

    if (room.members.length === 0) {
      rooms.delete(roomId);
    } else {
      room.members.forEach((m) => io.to(m.id).emit('peer-left', { socketId: socket.id, count: room.members.length }));
      io.to(roomId).emit('room-state', {
        participants: room.members.map((m) => ({ id: m.id, role: m.role, displayName: m.displayName, browser: m.browser || null })),
        mediaState: { screenActive: !!room.screenActive, camActive: !!room.camActive, hostId: room.hostId || null }
      });
      emitPeerCount(roomId);
    }
    emitRoomList();
  });

  socket.on('disconnect', () => {
    const roomId = sanitizeRoomId(socket.data.roomId);
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;

    room.members = room.members.filter((m) => m.id !== socket.id);
    if (room.hostId === socket.id) {
      room.hostId = null;
      room.screenActive = false;
      room.camActive = false;
    }

    if (room.members.length === 0) {
      rooms.delete(roomId);
    } else {
      room.members.forEach((m) => io.to(m.id).emit('peer-left', {
        socketId: socket.id,
        count: room.members.length,
      }));
      io.to(roomId).emit('room-state', {
        participants: room.members.map((m) => ({ id: m.id, role: m.role, displayName: m.displayName, browser: m.browser || null })),
        mediaState: { screenActive: !!room.screenActive, camActive: !!room.camActive, hostId: room.hostId || null }
      });
      emitPeerCount(roomId);
    }

    emitRoomList();
  });
});

server.listen(PORT, () => console.log('Watch Room multi-viewer running on port ' + PORT));
