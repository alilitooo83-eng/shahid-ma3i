
const socket = io();

console.log("Shahid Ma3i connected");

const video = document.getElementById("video");
const remoteVideo = document.getElementById("remoteVideo");
const status = document.getElementById("status");
const cameraBtn = document.getElementById("cameraBtn");

let localStream;
let peerConnection;
let roomId;
let pendingCandidates = [];

socket.on("connect", () => {
    console.log("Connected to server:", socket.id);
});

cameraBtn.onclick = async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        video.srcObject = localStream;
        status.innerText = "الكاميرا والميكروفون يعملان ✅";
    } catch (error) {
        console.error(error);
        status.innerText = "تعذّر تشغيل الكاميرا أو الميكروفون";
    }
};

function createRoom() {
    if (!localStream) {
        status.innerText = "شغّل الكاميرا أولًا";
        return;
    }

    socket.emit("create-room", (result) => {
        if (!result || !result.success) {
            status.innerText = "تعذّر إنشاء الجلسة";
            return;
        }

        roomId = result.roomId;
        document.getElementById("sessionCode").innerText = roomId;
        status.innerText = "تم إنشاء الجلسة ✅";
    });
}

function joinRoom() {
    if (!localStream) {
        status.innerText = "شغّل الكاميرا أولًا";
        return;
    }

    const input = document.getElementById("joinInput");
    const requestedRoomId = input.value.trim().toUpperCase();

    if (!requestedRoomId) {
        status.innerText = "أدخل رمز الجلسة أولًا";
        return;
    }

    socket.emit("join-room", requestedRoomId, (result) => {
        if (!result || !result.success) {
            status.innerText = result?.message || "تعذّر الانضمام";
            return;
        }

        roomId = result.roomId;
        status.innerText = "تم الانضمام، جارٍ الاتصال...";
    });
}

function createPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection();

    localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && roomId) {
            socket.emit("ice-candidate", {
                roomId,
                candidate: event.candidate
            });
        }
    };

    const candidates = pendingCandidates;
    pendingCandidates = [];

    return candidates;
}

socket.on("user-joined", async () => {
    try {
        if (!localStream) {
            status.innerText = "شغّل الكاميرا أولًا";
            return;
        }

        createPeerConnection();

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        socket.emit("offer", {
            roomId,
            offer
        });

        status.innerText = "جارٍ الاتصال بالطرف الآخر...";
    } catch (error) {
        console.error(error);
        status.innerText = "تعذّر بدء الاتصال";
    }
});

socket.on("offer", async (offer) => {
    try {
        if (!localStream) {
            status.innerText = "شغّل الكاميرا أولًا";
            return;
        }

        createPeerConnection();

        await peerConnection.setRemoteDescription(offer);

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit("answer", {
            roomId,
            answer
        });

        for (const candidate of pendingCandidates) {
            await peerConnection.addIceCandidate(candidate);
        }

        pendingCandidates = [];
        status.innerText = "تم الاتصال بالطرف الآخر";
    } catch (error) {
        console.error(error);
        status.innerText = "حدث خطأ أثناء الاتصال";
    }
});

socket.on("answer", async (answer) => {
    try {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(answer);

            for (const candidate of pendingCandidates) {
                await peerConnection.addIceCandidate(candidate);
            }

            pendingCandidates = [];
            status.innerText = "تم الاتصال بالطرف الآخر";
        }
    } catch (error) {
        console.error(error);
        status.innerText = "تعذّر إكمال الاتصال";
    }
});

socket.on("ice-candidate", async (candidate) => {
    try {
        if (peerConnection && peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(candidate);
        } else {
            pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.error(error);
    }
});
