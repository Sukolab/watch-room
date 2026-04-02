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
function getRoomMembers(roomId){ return rooms.get(roomId) || []; }
function emitPeerCount(roomId){
  const members = getRoomMembers(roomId);
  members.forEach((peerId) => io.to(peerId).emit('peer-count', { count: members.length }));
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, displayName }) => {
    roomId = String(roomId || '').trim();
    displayName = String(displayName || 'Guest').trim() || 'Guest';
    if (!roomId) return socket.emit('room-error', 'Missing room code.');
    const members = getRoomMembers(roomId);
    if (members.length >= 2) return socket.emit('room-full');

    socket.data.roomId = roomId;
    socket.data.displayName = displayName;
    members.push(socket.id);
    rooms.set(roomId, members);
    socket.join(roomId);

    const peers = members.filter((id) => id !== socket.id);
    socket.emit('joined-room', { roomId, peers, count: members.length });
    peers.forEach((peerId) => io.to(peerId).emit('peer-joined', { socketId: socket.id, displayName, count: members.length }));
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
    const nextMembers = members.filter((id) => id !== socket.id);
    if (nextMembers.length === 0) rooms.delete(roomId);
    else {
      rooms.set(roomId, nextMembers);
      nextMembers.forEach((peerId) => io.to(peerId).emit('peer-left', { count: nextMembers.length }));
      emitPeerCount(roomId);
    }
  });
});

server.listen(PORT, () => console.log('Watch Room running on port ' + PORT));
