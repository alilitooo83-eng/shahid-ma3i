const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: true,
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname)));

const rooms = new Map();
const socketRoomMap = new Map();

function buildRoomId() {
    return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function getRoom(socketId) {
    const roomId = socketRoomMap.get(socketId);
    if (!roomId) return null;
    return rooms.get(roomId) || null;
}

function notifyRoomEnded(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    for (const memberId of room.members) {
        socketRoomMap.delete(memberId);
    }

    io.to(roomId).emit("room-ended");
    rooms.delete(roomId);
}

function removeSocketFromRoom(socketId) {
    const roomId = socketRoomMap.get(socketId);
    if (!roomId) return;

    const room = rooms.get(roomId);
    socketRoomMap.delete(socketId);

    if (!room) return;

    room.members.delete(socketId);

    if (room.creator === socketId) {
        notifyRoomEnded(roomId);
        return;
    }

    if (room.members.size === 0) {
        rooms.delete(roomId);
        return;
    }

    if (room.members.size < 2) {
        io.to(roomId).emit("peer-left");
    }
}

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("create-room", (callback) => {
        const roomId = buildRoomId();

        rooms.set(roomId, {
            creator: socket.id,
            members: new Set([socket.id])
        });

        socketRoomMap.set(socket.id, roomId);
        socket.join(roomId);

        console.log("Room created:", roomId);

        if (typeof callback === "function") {
            callback({ success: true, roomId });
        }
    });

    socket.on("join-room", (roomId, callback) => {
        if (typeof roomId !== "string") {
            if (typeof callback === "function") {
                callback({ success: false, message: "رمز الجلسة غير صالح" });
            }
            return;
        }

        roomId = roomId.trim().toUpperCase();
        const room = rooms.get(roomId);

        if (!room) {
            if (typeof callback === "function") {
                callback({ success: false, message: "الجلسة غير موجودة" });
            }
            return;
        }

        if (room.members.size >= 2 && !room.members.has(socket.id)) {
            if (typeof callback === "function") {
                callback({ success: false, message: "الجلسة مكتملة" });
            }
            return;
        }

        room.members.add(socket.id);
        socketRoomMap.set(socket.id, roomId);
        socket.join(roomId);

        console.log("User joined room:", roomId);

        if (typeof callback === "function") {
            callback({ success: true, roomId, creatorId: room.creator });
        }

        socket.to(roomId).emit("user-joined", { roomId });
    });

    socket.on("offer", (data) => {
        if (data && data.roomId && rooms.has(data.roomId)) {
            socket.to(data.roomId).emit("offer", data.offer);
        }
    });

    socket.on("answer", (data) => {
        if (data && data.roomId && rooms.has(data.roomId)) {
            socket.to(data.roomId).emit("answer", data.answer);
        }
    });

    socket.on("ice-candidate", (data) => {
        if (data && data.roomId && rooms.has(data.roomId)) {
            socket.to(data.roomId).emit("ice-candidate", data.candidate);
        }
    });

    socket.on("end-session", () => {
        const room = getRoom(socket.id);
        if (room) {
            notifyRoomEnded(socketRoomMap.get(socket.id));
        }
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
        removeSocketFromRoom(socket.id);
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});