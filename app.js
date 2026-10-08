const socket = io();

console.log("Shahid Ma3i connected");

const status = document.getElementById("status");
const video = document.getElementById("video");
const cameraBtn = document.getElementById("cameraBtn");

let localStream;


// اتصال السيرفر
socket.on("connect", () => {
    console.log("Connected to server:", socket.id);

    if (status) {
        status.innerText = "متصل بالخادم ✅";
    }
});


// تشغيل الكاميرا
if (cameraBtn) {

    cameraBtn.onclick = async () => {

        try {

            localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });


            video.srcObject = localStream;

            status.innerText = "الكاميرا تعمل ✅";


        } catch (error) {

            console.log(error);

            status.innerText = "لم يتم تشغيل الكاميرا ❌";

        }

    };

}


// إنشاء جلسة
function createRoom() {

    const roomId = Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();


    socket.emit("create-room", roomId);


    document.getElementById("sessionCode").innerText = roomId;


    console.log("Room:", roomId);

}


// دخول جلسة
function joinRoom() {

    const input = document.getElementById("joinInput");

    const roomId = input.value.toUpperCase();


    if (!roomId) {

        alert("أدخل رمز الجلسة");

        return;
    }


    socket.emit("join-room", roomId);

    console.log("Joined:", roomId);

}


socket.on("user-joined", () => {

    alert("تم اتصال شخص آخر بالجهاز ✅");

});
