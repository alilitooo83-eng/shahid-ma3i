require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins.includes("*") ? true : allowedOrigins,
  methods: ["GET", "POST"],
  credentials: true
};

app.use(helmet());
app.use(compression());
app.use(cors(corsOptions));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

const rooms = new Map();
const socketRoomMap = new Map();
const roomTimers = new Map();
const ROOM_TTL_MS = 60 * 60 * 1000;
const MAX_ROOM_MEMBERS = 2;
const ROOM_ID_BYTES = 4;
const SESSION_TOKEN_BYTES = 16;

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString("hex").toUpperCase();
}

function buildRoomId() {
  return randomToken(ROOM_ID_BYTES);
}

function buildSessionToken() {
  return randomToken(SESSION_TOKEN_BYTES);
}

function normalizeRoomId(roomId) {
  return typeof roomId === "string" ? roomId.trim().toUpperCase() : "";
}

function getRoomForSocket(socketId) {
  const roomId = socketRoomMap.get(socketId);
  return roomId ? rooms.get(roomId) || null : null;
}

function isRoomMember(room, socketId) {
  return Boolean(room && room.members.has(socketId));
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
      console.log(`[room] expired empty room ${roomId}`);
    }
    roomTimers.delete(roomId);
  }, ROOM_TTL_MS);
  roomTimers.set(roomId, timer);
}

function safeAck(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

function validateSession(socket, payload) {
  const room = getRoomForSocket(socket.id);
  if (!room) return { ok: false, room: null };
  if (!isRoomMember(room, socket.id)) return { ok: false, room: null };
  const token = payload && typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  const expected = room.tokens.get(socket.id);
  if (!token || token !== expected) return { ok: false, room: null };
  return { ok: true, room };
}

function validateSignalPayload(payload, field) {
  return Boolean(payload && typeof payload.roomId === "string" && payload[field]);
}

function detachSocket(socketId) {
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

  if (room.creator === socketId) {
    room.ended = true;
    io.to(roomId).emit("room-ended", { roomId });
    rooms.delete(roomId);
    clearRoomTimer(roomId);
    return;
  }

  io.to(roomId).emit("peer-left", { roomId, userId: socketId });
}

app.get("/ice-config", (_req, res) => {
  const iceServers = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ];

  const turnUrls = (process.env.TURN_URL || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const turnUsername = process.env.TURN_USERNAME || "";
  const turnPassword = process.env.TURN_PASSWORD || "";

  if (turnUrls.length && turnUsername && turnPassword) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnPassword
    });
  }

  res.set("Cache-Control", "no-store");
  res.json({ iceServers, turnConfigured: iceServers.length > 1 });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

io.on("connection", (socket) => {
  console.log(`[socket] connected ${socket.id}`);

  socket.on("create-room", (callback) => {
    try {
      const roomId = buildRoomId();
      const sessionToken = buildSessionToken();
      rooms.set(roomId, {
        id: roomId,
        creator: socket.id,
        members: new Set([socket.id]),
        tokens: new Map([[socket.id, sessionToken]]),
        createdAt: Date.now(),
        ended: false
      });
      socketRoomMap.set(socket.id, roomId);
      socket.join(roomId);
      scheduleRoomCleanup(roomId);
      safeAck(callback, { success: true, roomId, sessionToken, creatorId: socket.id });
      console.log(`[room] created ${roomId}`);
    } catch (error) {
      console.error("[room] create error", error);
      safeAck(callback, { success: false, message: "تعذّر إنشاء الجلسة" });
    }
  });

  socket.on("join-room", (data, callback) => {
    try {
      const roomId = normalizeRoomId(data && data.roomId);
      if (!roomId) return safeAck(callback, { success: false, message: "رمز الجلسة غير صالح" });
      const room = rooms.get(roomId);
      if (!room) return safeAck(callback, { success: false, message: "الجلسة غير موجودة" });
      if (room.ended) return safeAck(callback, { success: false, message: "انتهت الجلسة" });
      if (room.members.size >= MAX_ROOM_MEMBERS && !room.members.has(socket.id)) {
        return safeAck(callback, { success: false, message: "الجلسة مكتملة" });
      }

      room.members.add(socket.id);
      const memberToken = buildSessionToken();
      room.tokens.set(socket.id, memberToken);
      socketRoomMap.set(socket.id, roomId);
      socket.join(roomId);
      scheduleRoomCleanup(roomId);

      safeAck(callback, {
        success: true,
        roomId,
        sessionToken: memberToken,
        creatorId: room.creator
      });

      socket.to(roomId).emit("user-joined", { roomId, userId: socket.id });
      console.log(`[room] ${socket.id} joined ${roomId}`);
    } catch (error) {
      console.error("[room] join error", error);
      safeAck(callback, { success: false, message: "تعذّر الانضمام" });
    }
  });

  socket.on("offer", (data) => {
    try {
      const validation = validateSession(socket, data);
      if (!validation.ok || !validateSignalPayload(data, "offer")) return;
      io.to(validation.room.id).except(socket.id).emit("offer", {
        offer: data.offer,
        roomId: data.roomId,
        senderId: socket.id
      });
    } catch (error) {
      console.error("[signal] offer error", error);
    }
  });

  socket.on("answer", (data) => {
    try {
      const validation = validateSession(socket, data);
      if (!validation.ok || !validateSignalPayload(data, "answer")) return;
      io.to(validation.room.id).except(socket.id).emit("answer", {
        answer: data.answer,
        roomId: data.roomId,
        senderId: socket.id
      });
    } catch (error) {
      console.error("[signal] answer error", error);
    }
  });

  socket.on("ice-candidate", (data) => {
    try {
      const validation = validateSession(socket, data);
      if (!validation.ok || !validateSignalPayload(data, "candidate")) return;
      io.to(validation.room.id).except(socket.id).emit("ice-candidate", {
        candidate: data.candidate,
        roomId: data.roomId,
        senderId: socket.id
      });
    } catch (error) {
      console.error("[signal] ice-candidate error", error);
    }
  });

  socket.on("end-session", async (_data, callback) => {
    const room = getRoomForSocket(socket.id);
    if (!room || room.ended) {
      return safeAck(callback, { success: false, message: "الجلسة منتهية بالفعل" });
    }
    if (room.creator !== socket.id) {
      return safeAck(callback, { success: false, message: "فقط منشئ الجلسة يستطيع إنهاؤها" });
    }

    room.ended = true;
    const roomId = room.id;
    socket.to(roomId).emit("room-ended", { roomId });
    await new Promise((resolve) => setImmediate(resolve));
    rooms.delete(roomId);
    clearRoomTimer(roomId);
    for (const memberId of room.members) socketRoomMap.delete(memberId);
    safeAck(callback, { success: true });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[socket] disconnected ${socket.id}: ${reason}`);
    detachSocket(socket.id);
  });

  socket.on("error", (error) => console.error(`[socket] error ${socket.id}`, error));
});

process.on("uncaughtException", (error) => console.error("[fatal] uncaughtException", error));
process.on("unhandledRejection", (error) => console.error("[fatal] unhandledRejection", error));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));