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

function buildRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
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

function getRoomBySocket(socketId) {
  const roomId = socketRoomMap.get(socketId);
  return roomId ? rooms.get(roomId) || null : null;
}

function detachSocket(socketId) {
  const roomId = socketRoomMap.get(socketId);
  if (!roomId) return;

  const room = rooms.get(roomId);
  socketRoomMap.delete(socketId);
  if (!room) return;

  room.members.delete(socketId);
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
      rooms.set(roomId, { creator: socket.id, members: new Set([socket.id]), createdAt: Date.now() });
      socketRoomMap.set(socket.id, roomId);
      socket.join(roomId);
      scheduleRoomCleanup(roomId);
      if (typeof callback === "function") callback({ success: true, roomId });
      console.log(`[room] created ${roomId}`);
    } catch (error) {
      console.error("[room] create error", error);
      if (typeof callback === "function") callback({ success: false, message: "تعذّر إنشاء الجلسة" });
    }
  });

  socket.on("join-room", (roomId, callback) => {
    try {
      if (typeof roomId !== "string") {
        if (typeof callback === "function") callback({ success: false, message: "رمز الجلسة غير صالح" });
        return;
      }

      const normalizedRoomId = roomId.trim().toUpperCase();
      const room = rooms.get(normalizedRoomId);
      if (!room) {
        if (typeof callback === "function") callback({ success: false, message: "الجلسة غير موجودة" });
        return;
      }

      if (room.members.size >= 2 && !room.members.has(socket.id)) {
        if (typeof callback === "function") callback({ success: false, message: "الجلسة مكتملة" });
        return;
      }

      room.members.add(socket.id);
      socketRoomMap.set(socket.id, normalizedRoomId);
      socket.join(normalizedRoomId);
      scheduleRoomCleanup(normalizedRoomId);
      if (typeof callback === "function") callback({ success: true, roomId: normalizedRoomId, creatorId: room.creator });
      socket.to(normalizedRoomId).emit("user-joined", { roomId: normalizedRoomId, userId: socket.id });
      console.log(`[room] ${socket.id} joined ${normalizedRoomId}`);
    } catch (error) {
      console.error("[room] join error", error);
      if (typeof callback === "function") callback({ success: false, message: "تعذّر الانضمام" });
    }
  });

  socket.on("offer", (data) => {
    try {
      if (!data || typeof data.roomId !== "string" || !rooms.has(data.roomId) || !data.offer) return;
      socket.to(data.roomId).emit("offer", data.offer);
    } catch (error) {
      console.error("[signal] offer error", error);
    }
  });

  socket.on("answer", (data) => {
    try {
      if (!data || typeof data.roomId !== "string" || !rooms.has(data.roomId) || !data.answer) return;
      socket.to(data.roomId).emit("answer", data.answer);
    } catch (error) {
      console.error("[signal] answer error", error);
    }
  });

  socket.on("ice-candidate", (data) => {
    try {
      if (!data || typeof data.roomId !== "string" || !rooms.has(data.roomId) || !data.candidate) return;
      socket.to(data.roomId).emit("ice-candidate", data.candidate);
    } catch (error) {
      console.error("[signal] ice-candidate error", error);
    }
  });

  socket.on("end-session", () => {
    const room = getRoomBySocket(socket.id);
    if (room) destroyRoom(socketRoomMap.get(socket.id), "room-ended");
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