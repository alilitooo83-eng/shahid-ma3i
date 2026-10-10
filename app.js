
const socket = io();

console.log("Shahid Ma3i connected");

const video = document.getElementById("video");
const remoteVideo = document.getElementById("remoteVideo");


let isFullscreen = false;

const videoContainer = document.querySelector(".video-container");

remoteVideo.onclick = () => {

    isFullscreen = !isFullscreen;

    document.body.classList.toggle(
        "fullscreen-mode",
        isFullscreen
    );

};
const status = document.getElementById("status");
const cameraBtn = document.getElementById("cameraBtn");
const switchCameraBtn = document.getElementById("switchCameraBtn");

let localStream;
let currentFacingMode = "user";
let peerConnection;
let roomId;
let pendingCandidates = [];
// ---------- WebRTC Configuration ----------

const rtcConfig = {

    iceServers: [

        {
            urls: [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        }

    ],

    iceCandidatePoolSize: 10

};

const inviteRoomId =
    new URLSearchParams(window.location.search).get("room");

socket.on("connect", () => {
    console.log("Connected to server:", socket.id);
});

cameraBtn.onclick = async () => {
    try {
        if (!localStream) {
           localStream = await navigator.mediaDevices.getUserMedia({
    video: {
        facingMode: currentFacingMode
    },
    audio: true
});

            video.srcObject = localStream;
        }

        status.innerText = "الكاميرا والميكروفون يعملان ✅";

        if (inviteRoomId && !roomId) {
            document.getElementById("joinInput").value =
                inviteRoomId.toUpperCase();

            joinRoom();
        }
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
        console.log("Room ID =", roomId);

        document.getElementById("sessionCode").innerText = roomId;
        console.log("Session code updated");

        const inviteLink = new URL(window.location.href);
        inviteLink.search = "";
        inviteLink.searchParams.set("room", roomId);

        status.innerText = "تم إنشاء الجلسة ✅";
        document.getElementById("sessionArea").style.display = "block";

        let inviteArea = document.getElementById("inviteArea");

        if (!inviteArea) {
            inviteArea = document.createElement("div");
            inviteArea.id = "inviteArea";
            inviteArea.style.marginTop = "12px";
            document.getElementById("sessionArea")
                .appendChild(inviteArea);
        }

        inviteArea.innerHTML = `
       
            <p>رابط الدعوة:</p>
            <input id="inviteLink" readonly>
            <button id="copyInviteBtn">نسخ رابط الدعوة</button>
            <button id="shareInviteBtn">مشاركة عبر واتساب</button>
        `;

        document.getElementById("inviteLink").value =
            inviteLink.toString();

        document.getElementById("copyInviteBtn").onclick = async () => {
            try {
                await navigator.clipboard.writeText(inviteLink.toString());
                status.innerText = "تم نسخ رابط الدعوة ✅";
            } catch (error) {
                const field = document.getElementById("inviteLink");
                field.select();
                status.innerText = "حدّد الرابط وانسخه يدويًا";
            }
        };

        document.getElementById("shareInviteBtn").onclick = () => {
            const message = encodeURIComponent(
                "انضم إليّ في جلسة شاهد معي:\n" +
                inviteLink.toString()
            );

            window.open(
                "https://wa.me/?text=" + message,
                "_blank"
            );
        };
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
        document.querySelector(".join").style.display = "none";
    });
}

function createPeerConnection() {

    if (peerConnection) {
        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onconnectionstatechange = () => {
        console.log("Connection:", peerConnection.connectionState);

        switch (peerConnection.connectionState) {

            case "connected":
                status.innerText = "تم الاتصال بنجاح ✅";
                break;

            case "connecting":
                status.innerText = "جارٍ الاتصال...";
                break;

            case "failed":
                status.innerText = "فشل الاتصال";
                break;

            case "disconnected":
                status.innerText = "انقطع الاتصال";
                break;

            case "closed":
                status.innerText = "تم إنهاء الجلسة";
                break;
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log("ICE:", peerConnection.iceConnectionState);
    };

    peerConnection.onicegatheringstatechange = () => {
        console.log("Gathering:", peerConnection.iceGatheringState);
    };

    peerConnection.onsignalingstatechange = () => {
        console.log("Signaling:", peerConnection.signalingState);
    };

    peerConnection.onicecandidate = (event) => {

        if (event.candidate && roomId) {

            socket.emit("ice-candidate", {
                roomId,
                candidate: event.candidate
            });

        }

    };

    return pendingCandidates;
}

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
switchCameraBtn.onclick = async () => {

    if (!localStream) {
        status.innerText = "شغّل الكاميرا أولًا";
        return;
    }

    currentFacingMode =
        currentFacingMode === "user"
            ? "environment"
            : "user";

    localStream.getTracks().forEach(track => track.stop());

    try {

        localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: currentFacingMode
            },
            audio: true
        });

        video.srcObject = localStream;
        if (peerConnection) {

    const sender = peerConnection
        .getSenders()
        .find(sender =>
            sender.track &&
            sender.track.kind === "video"
        );

    if (sender) {
    await sender.replaceTrack(
        localStream.getVideoTracks()[0]
    );
}

}
        

        status.innerText =
            currentFacingMode === "user"
                ? "تم تشغيل الكاميرا الأمامية ✅"
                : "تم تشغيل الكاميرا الخلفية ✅";

    } catch (error) {

        console.error(error);

        status.innerText =
            "تعذّر تبديل الكاميرا";

    }

};
