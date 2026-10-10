
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

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("create-room", (callback) => {
        const roomId = crypto.randomBytes(4).toString("hex").toUpperCase();

        rooms.set(roomId, {
            creator: socket.id,
            members: new Set([socket.id])
        });

        socket.join(roomId);
        console.log("Room created:", roomId);

        if (typeof callback === "function") {
            callback({ success: true, roomId });
        }
    });

    socket.on("join-room", (roomId, callback) => {
        console.log("JOIN REQUEST:", roomId, socket.id);
        console.log("Rooms:", [...rooms.keys()]);
        if (typeof roomId !== "string") return;

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

        const existingMember = [...room.members].find(id => id !== socket.id);

        room.members.add(socket.id);
        socket.join(roomId);

        console.log("User joined room:", roomId);

        if (typeof callback === "function") {
            callback({ success: true, roomId });
        }

        if (existingMember) {
            io.to(existingMember).emit("user-joined");
        }
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

        for (const [roomId, room] of rooms) {
            room.members.delete(socket.id);

            if (room.members.size === 0) {
                rooms.delete(roomId);
                console.log("Room removed:", roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
