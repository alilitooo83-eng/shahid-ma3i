const socket = io();

console.log("Shahid Ma3i connected");

const status = document.getElementById("status");


socket.on("connect", () => {
    console.log("Connected to server:", socket.id);

    if (status) {
        status.innerText = "متصل بالخادم ✅";
    }
});


socket.on("disconnect", () => {
    console.log("Disconnected");

    if (status) {
        status.innerText = "انقطع الاتصال ❌";
    }
});


// إنشاء جلسة
function createRoom() {

    const roomId = Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();

    socket.emit("create-room", roomId);

    console.log("Room created:", roomId);


    const sessionCode = document.getElementById("sessionCode");

    if (sessionCode) {
        sessionCode.innerText = roomId;
    }

}


// الانضمام إلى جلسة
function joinRoom() {

    const input = document.getElementById("joinInput");

    if (!input || !input.value) {
        alert("أدخل رمز الجلسة");
        return;
    }


    const roomId = input.value.toUpperCase();

    socket.emit("join-room", roomId);

    console.log("Joined room:", roomId);

}


// عندما يدخل شخص آخر
socket.on("user-joined", () => {

    console.log("User joined the room");

    alert("تم اتصال المستخدم الآخر ✅");

});
