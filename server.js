const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server);

app.use(express.static(path.join(__dirname)));

io.on("connection", (socket) => {

    console.log("User connected:", socket.id);

    socket.on("create-room", (roomId) => {

        socket.join(roomId);

        console.log("Room created:", roomId);

    });


    socket.on("join-room", (roomId) => {

        socket.join(roomId);

        console.log("User joined room:", roomId);

        socket.to(roomId).emit("user-joined");

    });


    socket.on("disconnect", () => {

        console.log("User disconnected:", socket.id);

    });

});


const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {

    console.log(`Server running on port ${PORT}`);

});
