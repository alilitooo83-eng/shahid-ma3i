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


// إرسال رسالة تجريبية
function sendTest() {
    socket.emit("message", {
        text: "Hello from Shahid Ma3i",
        time: new Date()
    });
}


// استقبال الرسائل
socket.on("message", (data) => {
    console.log("Received:", data);
});
