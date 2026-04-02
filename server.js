const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(__dirname + '/index.html'));

const rooms = new Map(); // roomId -> [{id, role}]
function getRoomMembers(roomId){ return rooms.get(roomId) || []; }
function emitPeerCount(roomId){
  const members = getRoomMembers(roomId);
  members.forEach((m) => io.to(m.id).emit('peer-count', { count: members.length }));
}
function hostExists(members){ return members.some((m) => m.role === 'host'); }

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, displayName, requestedRole }) => {
    roomId = String(roomId || '').trim();
    displayName = String(displayName || 'Guest').trim() || 'Guest';
    requestedRole = requestedRole === 'host' ? 'host' : 'viewer';

    if (!roomId) return socket.emit('room-error', 'Missing room code.');
    const members = getRoomMembers(roomId);
    if (members.length >= 2) return socket.emit('room-full');

    let role = requestedRole;
    if (role === 'host' && hostExists(members)) role = 'viewer';

    socket.data.roomId = roomId;
    socket.data.displayName = displayName;
    socket.data.role = role;

    members.push({ id: socket.id, role });
    rooms.set(roomId, members);
    socket.join(roomId);

    const peers = members.filter((m) => m.id !== socket.id).map((m) => m.id);
    socket.emit('joined-room', { roomId, peers, count: members.length, isHost: role === 'host' });

    peers.forEach((peerId) => {
      io.to(peerId).emit('peer-joined', { socketId: socket.id, displayName, count: members.length });
    });

    emitPeerCount(roomId);
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const members = getRoomMembers(roomId);
    const nextMembers = members.filter((m) => m.id !== socket.id);

    if (nextMembers.length === 0) rooms.delete(roomId);
    else {
      rooms.set(roomId, nextMembers);
      nextMembers.forEach((m) => io.to(m.id).emit('peer-left', { count: nextMembers.length }));
      emitPeerCount(roomId);
    }
  });
});

server.listen(PORT, () => console.log('Watch Room v2 running on port ' + PORT));
