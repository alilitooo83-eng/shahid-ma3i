require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true,
};

app.use(helmet());
app.use(compression());
app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

const rooms = new Map();
const socketRoomMap = new Map();
const roomTimers = new Map();
const ROOM_TTL_MS = 60 * 60 * 1000;
const MAX_ROOM_MEMBERS = 2;
const FALLBACK_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

function log(tag, details = '') {
  console.log(`[SERVER] ${tag}`, details);
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('hex').toUpperCase();
}

function buildRoomId() {
  return randomToken(4);
}

function buildSessionToken() {
  return randomToken(16);
}

function normalizeRoomId(roomId) {
  return typeof roomId === 'string' ? roomId.trim().toUpperCase() : '';
}

function safeAck(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function clearRoomTimer(roomId) {
  const timer = roomTimers.get(roomId);
  if (timer) clearTimeout(timer);
  roomTimers.delete(roomId);
}

function scheduleRoomCleanup(roomId) {
  clearRoomTimer(roomId);
  const timer = setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && room.members.size === 0) {
      rooms.delete(roomId);
      log('ROOM_DESTROYED', roomId);
    }
    roomTimers.delete(roomId);
  }, ROOM_TTL_MS);
  roomTimers.set(roomId, timer);
}

function getRoomBySocket(socketId) {
  const roomId = socketRoomMap.get(socketId);
  return roomId ? rooms.get(roomId) || null : null;
}

function validateRoomMembership(socket, payload) {
  const room = getRoomBySocket(socket.id);
  if (!room) return null;
  const token = payload && typeof payload.sessionToken === 'string' ? payload.sessionToken : '';
  const expected = room.tokens.get(socket.id);
  if (!token || token !== expected) return null;
  return room;
}

function destroyRoom(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.ended = true;
  io.to(roomId).emit('room-ended', { roomId, reason });

  for (const memberId of room.members) {
    socketRoomMap.delete(memberId);
  }

  clearRoomTimer(roomId);
  rooms.delete(roomId);
  log('ROOM_DESTROYED', `${roomId}${reason ? ` (${reason})` : ''}`);
}

function removeSocketFromRoom(socketId, reason) {
  const roomId = socketRoomMap.get(socketId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  socketRoomMap.delete(socketId);
  if (!room) return;

  room.members.delete(socketId);
  room.tokens.delete(socketId);

  if (room.members.size === 0) {
    scheduleRoomCleanup(roomId);
    return;
  }

  const payload = { roomId, peerId: socketId, reason };
  io.to(roomId).emit('peer-left', payload);
  log('PEER_LEFT', JSON.stringify(payload));

  if (room.creator === socketId) {
    destroyRoom(roomId, 'creator-left');
  }
}

app.get('/ice-config', (_req, res) => {
  const iceServers = [...FALLBACK_ICE_SERVERS];
  const turnUrls = (process.env.TURN_URL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const turnUsername = (process.env.TURN_USERNAME || '').trim();
  const turnPassword = (process.env.TURN_PASSWORD || '').trim();

  if (turnUrls.length && turnUsername && turnPassword) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnPassword,
    });
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    iceServers,
    turnConfigured: iceServers.length > FALLBACK_ICE_SERVERS.length,
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

io.on('connection', (socket) => {
  log('SOCKET_CONNECTED', socket.id);

  socket.on('create-room', (callback) => {
    try {
      const roomId = buildRoomId();
      const sessionToken = buildSessionToken();

      rooms.set(roomId, {
        id: roomId,
        creator: socket.id,
        members: new Set([socket.id]),
        tokens: new Map([[socket.id, sessionToken]]),
        createdAt: Date.now(),
        ended: false,
      });

      socketRoomMap.set(socket.id, roomId);
      socket.join(roomId);
      scheduleRoomCleanup(roomId);
      safeAck(callback, { success: true, roomId, sessionToken, role: 'creator' });
      log('ROOM_CREATED', roomId);
    } catch (error) {
      console.error('[SERVER] create-room failed', error);
      safeAck(callback, { success: false, message: 'تعذّر إنشاء الجلسة' });
    }
  });

  socket.on('join-room', (payload, callback) => {
    try {
      const roomId = normalizeRoomId(payload && payload.roomId);
      if (!roomId) return safeAck(callback, { success: false, message: 'رمز الجلسة غير صالح' });

      const room = rooms.get(roomId);
      if (!room) return safeAck(callback, { success: false, message: 'الجلسة غير موجودة' });
      if (room.ended) return safeAck(callback, { success: false, message: 'انتهت الجلسة' });
      if (room.members.size >= MAX_ROOM_MEMBERS && !room.members.has(socket.id)) {
        return safeAck(callback, { success: false, message: 'الجلسة مكتملة' });
      }

      room.members.add(socket.id);
      const sessionToken = buildSessionToken();
      room.tokens.set(socket.id, sessionToken);
      socketRoomMap.set(socket.id, roomId);
      socket.join(roomId);
      scheduleRoomCleanup(roomId);

      safeAck(callback, {
        success: true,
        roomId,
        sessionToken,
        role: room.creator === socket.id ? 'creator' : 'guest',
        creatorId: room.creator,
      });

      socket.to(roomId).emit('user-joined', {
        roomId,
        userId: socket.id,
      });

      log('USER_JOINED', `${socket.id} -> ${roomId}`);
    } catch (error) {
      console.error('[SERVER] join-room failed', error);
      safeAck(callback, { success: false, message: 'تعذّر الانضمام' });
    }
  });

  socket.on('offer', (payload) => {
    try {
      const room = validateRoomMembership(socket, payload);
      if (!room || !payload || !payload.offer) return;
      if (room.creator !== socket.id) return;
      socket.to(room.id).emit('offer', {
        offer: payload.offer,
        roomId: room.id,
        senderId: socket.id,
      });
      log('OFFER_SENT', room.id);
    } catch (error) {
      console.error('[SERVER] offer failed', error);
    }
  });

  socket.on('answer', (payload) => {
    try {
      const room = validateRoomMembership(socket, payload);
      if (!room || !payload || !payload.answer) return;
      if (room.creator === socket.id) return;
      socket.to(room.id).emit('answer', {
        answer: payload.answer,
        roomId: room.id,
        senderId: socket.id,
      });
      log('ANSWER_SENT', room.id);
    } catch (error) {
      console.error('[SERVER] answer failed', error);
    }
  });

  socket.on('ice-candidate', (payload) => {
    try {
      const room = validateRoomMembership(socket, payload);
      if (!room || !payload || !payload.candidate) return;
      socket.to(room.id).emit('ice-candidate', {
        candidate: payload.candidate,
        roomId: room.id,
        senderId: socket.id,
      });
      log('ICE_SENT', room.id);
    } catch (error) {
      console.error('[SERVER] ice-candidate failed', error);
    }
  });

  socket.on('end-session', (payload, callback) => {
    try {
      const room = validateRoomMembership(socket, payload);
      if (!room) return safeAck(callback, { success: false, message: 'لا توجد جلسة نشطة' });
      if (room.creator !== socket.id) return safeAck(callback, { success: false, message: 'فقط المنشئ يستطيع إنهاء الجلسة' });

      const roomId = room.id;
      io.to(roomId).emit('room-ended', { roomId, reason: 'creator-ended' });
      for (const memberId of room.members) socketRoomMap.delete(memberId);
      clearRoomTimer(roomId);
      rooms.delete(roomId);
      safeAck(callback, { success: true });
      log('ROOM_DESTROYED', `${roomId} (ended)`);
    } catch (error) {
      console.error('[SERVER] end-session failed', error);
      safeAck(callback, { success: false, message: 'تعذّر إنهاء الجلسة' });
    }
  });

  socket.on('disconnect', (reason) => {
    log('DISCONNECTED', `${socket.id} :: ${reason}`);
    removeSocketFromRoom(socket.id, reason);
  });
});

process.on('uncaughtException', (error) => console.error('[FATAL] uncaughtException', error));
process.on('unhandledRejection', (error) => console.error('[FATAL] unhandledRejection', error));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log('CONNECTED', `port ${PORT}`));