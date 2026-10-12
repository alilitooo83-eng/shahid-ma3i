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
const ROOM_ID_BYTES = 8;
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

function destroyRoom(roomId, reason = "room-ended") {
  const room = rooms.get(roomId);
  if (!room) return;

  clearRoomTimer(roomId);

  for (const memberId of room.members) {
    socketRoomMap.delete(memberId);
  }

  io.to(roomId).emit(reason, { roomId });
  rooms.delete(roomId);
  console.log(`[room] destroyed ${roomId} (${reason})`);
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

function issueRoomSignal(room, socket) {
  const token = buildSessionToken();
  room.tokens.set(socket.id, token);
  return token;
}

function validateSession(socket, payload) {
  const room = getRoomForSocket(socket.id);
  if (!room) return { ok: false, message: "SESSION_NOT_FOUND" };
  if (!isRoomMember(room, socket.id)) return { ok: false, message: "NOT_ROOM_MEMBER" };

  const token = payload && typeof payload.sessionToken === "string" ? payload.sessionToken : "";
  const expected = room.tokens.get(socket.id);
  if (!token || token !== expected) return { ok: false, message: "INVALID_SESSION_TOKEN" };

  return { ok: true, room };
}

function safeAck(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

function validateSignalPayload(payload, field) {
  return Boolean(payload && typeof payload.roomId === "string" && payload[field]);
}

function getRoomIdForSignal(room) {
  return room ? room.id : null;
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
    destroyRoom(roomId, "room-ended");
    return;
  }

  io.to(roomId).emit("peer-left", { roomId, userId: socketId });
}

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
      const sessionToken = data && typeof data.sessionToken === "string" ? data.sessionToken.trim().toUpperCase() : "";
      if (!roomId || !sessionToken) {
        safeAck(callback, { success: false, message: "رمز الجلسة أو التوكن غير صالح" });
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        safeAck(callback, { success: false, message: "الجلسة غير موجودة" });
        return;
      }

      if (room.ended) {
        safeAck(callback, { success: false, message: "انتهت الجلسة" });
        return;
      }

      if (room.members.size >= MAX_ROOM_MEMBERS && !room.members.has(socket.id)) {
        safeAck(callback, { success: false, message: "الجلسة مكتملة" });
        return;
      }

      const creatorToken = room.tokens.get(room.creator);
      if (!creatorToken || creatorToken !== sessionToken) {
        safeAck(callback, { success: false, message: "توكين الجلسة غير صحيح" });
        return;
      }

      room.members.add(socket.id);
      const memberToken = issueRoomSignal(room, socket);
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
      io.to(getRoomIdForSignal(validation.room)).except(socket.id).emit("offer", {
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
      io.to(getRoomIdForSignal(validation.room)).except(socket.id).emit("answer", {
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
      io.to(getRoomIdForSignal(validation.room)).except(socket.id).emit("ice-candidate", {
        candidate: data.candidate,
        roomId: data.roomId,
        senderId: socket.id
      });
    } catch (error) {
      console.error("[signal] ice-candidate error", error);
    }
  });

  socket.on("leave", (_data, callback) => {
    const room = getRoomForSocket(socket.id);
    if (!room) {
      safeAck(callback, { success: false, message: "لا توجد جلسة نشطة" });
      return;
    }

    detachSocket(socket.id);
    safeAck(callback, { success: true });
  });

  socket.on("reconnect", (_data, callback) => {
    const room = getRoomForSocket(socket.id);
    if (!room || !isRoomMember(room, socket.id)) {
      safeAck(callback, { success: false, message: "لا توجد جلسة لإعادة الاتصال" });
      return;
    }
    safeAck(callback, { success: true, roomId: socketRoomMap.get(socket.id) });
  });

  socket.on("end-session", (_data, callback) => {
    const room = getRoomForSocket(socket.id);
    if (!room || room.ended) {
      safeAck(callback, { success: false, message: "الجلسة منتهية بالفعل" });
      return;
    }

    if (room.creator !== socket.id) {
      safeAck(callback, { success: false, message: "فقط منشئ الجلسة يستطيع إنهاؤها" });
      return;
    }

    room.ended = true;
    destroyRoom(socketRoomMap.get(socket.id), "room-ended");
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