const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const rooms = new Map();
const socketRoomMap = new Map();

function removeSocketFromRoom(socketId) {
    const roomId = socketRoomMap.get(socketId);
    if (!roomId) {
        return;
    }

    const room = rooms.get(roomId);
    if (!room) {
        socketRoomMap.delete(socketId);
        return;
    }

    room.members.delete(socketId);
    socketRoomMap.delete(socketId);

    if (room.members.size === 0) {
        rooms.delete(roomId);
        return;
    }

    io.to(roomId).emit("room-ended");
}

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("create-room", (callback) => {
        const roomId = crypto.randomBytes(4).toString("hex").toUpperCase();

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
            callback({ success: true, roomId });
        }

        socket.to(roomId).emit("user-joined");
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

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
        removeSocketFromRoom(socket.id);
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
