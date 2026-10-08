const socket = io();

console.log("Shahid Ma3i connected");

const video = document.getElementById("video");
const remoteVideo = document.getElementById("remoteVideo");
const status = document.getElementById("status");

const cameraBtn = document.getElementById("cameraBtn");

let localStream;
let peerConnection;
let roomId;


// الاتصال
socket.on("connect", () => {

    console.log("Connected to server:", socket.id);

});


// تشغيل الكاميرا
cameraBtn.onclick = async () => {

    localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
    });


    video.srcObject = localStream;

    status.innerText = "الكاميرا تعمل ✅";

};


// إنشاء جلسة
function createRoom() {

    roomId = Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();


    socket.emit("create-room", roomId);


    document.getElementById("sessionCode").innerText = roomId;

}


// الانضمام
function joinRoom() {

    roomId = document
        .getElementById("joinInput")
        .value
        .toUpperCase();


    socket.emit("join-room", roomId);

}


// إنشاء اتصال WebRTC
function createPeerConnection() {


    peerConnection = new RTCPeerConnection();


    localStream.getTracks().forEach(track => {

        peerConnection.addTrack(
            track,
            localStream
        );

    });


    peerConnection.ontrack = (event) => {

        remoteVideo.srcObject = event.streams[0];

    };


    peerConnection.onicecandidate = (event) => {

        if(event.candidate){

            socket.emit("ice-candidate", {
                roomId,
                candidate:event.candidate
            });

        }

    };

}


// شخص دخل الغرفة
socket.on("user-joined", async () => {


    createPeerConnection();


    const offer = await peerConnection.createOffer();


    await peerConnection.setLocalDescription(offer);


    socket.emit("offer", {

        roomId,
        offer

    });


});


// استقبال offer
socket.on("offer", async (offer)=>{


    createPeerConnection();


    await peerConnection.setRemoteDescription(offer);


    const answer =
        await peerConnection.createAnswer();


    await peerConnection.setLocalDescription(answer);


    socket.emit("answer", {

        roomId,
        answer

    });


});


// استقبال answer
socket.on("answer", async(answer)=>{


    await peerConnection.setRemoteDescription(answer);


});


// استقبال ICE
socket.on("ice-candidate", async(candidate)=>{


    if(peerConnection){

        await peerConnection.addIceCandidate(candidate);

    }


});
