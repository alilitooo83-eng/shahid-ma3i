const socket = io();

console.log("Shahid Ma3i connected");

const status = document.getElementById("status");

let roomId = null;


// الاتصال بالسيرفر
socket.on("connect", () => {
    console.log("Connected to server:", socket.id);

    if (status) {
        status.innerText = "متصل بالخادم ✅";
    }
});


// إنشاء جلسة
function createRoom() {

    roomId = Math.random().toString(36).substring(2, 8).toUpperCase();

    socket.emit("create-room", roomId);

    console.log("Room created:", roomId);

    alert("رمز الجلسة: " + roomId);
}


// دخول جلسة
function joinRoom() {

    const input = document.getElementById("roomInput");

    if (!input.value) {
        alert("اكتب رمز الجلسة");
        return;
    }

    roomId = input.value.toUpperCase();

    socket.emit("join-room", roomId);

    console.log("Joined room:", roomId);
}


// استقبال دخول مستخدم
socket.on("user-joined", () => {

    console.log("Another user joined");

    alert("تم اتصال المستخدم الآخر ✅");

});
