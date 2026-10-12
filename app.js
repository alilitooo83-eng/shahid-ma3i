const socket = io();

console.log("Shahid Ma3i connected");

const localVideo = document.getElementById("video");
const remoteVideo = document.getElementById("remoteVideo");
const status = document.getElementById("status");
const cameraBtn = document.getElementById("cameraBtn");
const switchCameraBtn = document.getElementById("switchCameraBtn");
const sessionCodeEl = document.getElementById("sessionCode");
const sessionArea = document.getElementById("sessionArea");
const joinInput = document.getElementById("joinInput");
const joinSection = document.querySelector(".join");

let localStream = null;
let peerConnection = null;
let roomId = null;
let pendingCandidates = [];
let currentFacingMode = "user";
let isFullscreen = false;
let isCreator = false;
let sessionStarted = false;
let shouldCreateOffer = false;

const inviteRoomId = new URLSearchParams(window.location.search).get("room");

const rtcConfig = {
    iceServers: [
        {
            urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
        }
    ],
    iceCandidatePoolSize: 10
};

function setStatus(message) {
    if (status) {
        status.innerText = message;
    }
}

function cleanupPeerConnection() {
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.onicegatheringstatechange = null;
        peerConnection.onsignalingstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }
    pendingCandidates = [];
    sessionStarted = false;
    shouldCreateOffer = false;
    remoteVideo.srcObject = null;
}

function resetSessionState(message) {
    roomId = null;
    isCreator = false;
    joinSection.style.display = "none";
    if (message) setStatus(message);
    cleanupPeerConnection();
}

function ensurePeerConnection() {
    if (peerConnection) {
        return peerConnection;
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onconnectionstatechange = () => {
        console.log("Connection:", peerConnection.connectionState);
        if (peerConnection.connectionState === "connected") {
            setStatus("تم الاتصال بنجاح ✅");
        } else if (peerConnection.connectionState === "connecting") {
            setStatus("جارٍ الاتصال...");
        } else if (peerConnection.connectionState === "failed") {
            setStatus("فشل الاتصال");
        } else if (peerConnection.connectionState === "disconnected") {
            setStatus("انقطع الاتصال");
        } else if (peerConnection.connectionState === "closed") {
            setStatus("تم إنهاء الجلسة");
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && roomId) {
            socket.emit("ice-candidate", {
                roomId,
                candidate: event.candidate
            });
        }
    };

    if (localStream) {
        localStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });
    }

    return peerConnection;
}

async function createLocalStream() {
    if (localStream) {
        return localStream;
    }

    localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode },
        audio: true
    });

    localVideo.srcObject = localStream;
    return localStream;
}

async function addTracksToPeerConnection() {
    if (!peerConnection || !localStream) {
        return;
    }

    const senders = peerConnection.getSenders();
    const hasVideo = senders.some((sender) => sender.track && sender.track.kind === "video");
    const hasAudio = senders.some((sender) => sender.track && sender.track.kind === "audio");

    if (!hasVideo) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) peerConnection.addTrack(videoTrack, localStream);
    }

    if (!hasAudio) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) peerConnection.addTrack(audioTrack, localStream);
    }
}

async function startOfferIfNeeded() {
    if (!isCreator || sessionStarted || !roomId) {
        return;
    }

    const pc = ensurePeerConnection();
    await addTracksToPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", { roomId, offer });
    sessionStarted = true;
}

async function drainPendingCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) {
        return;
    }

    while (pendingCandidates.length) {
        const candidate = pendingCandidates.shift();
        await peerConnection.addIceCandidate(candidate);
    }
}

function endSession() {
    socket.emit("end-session");
    resetSessionState("تم إنهاء الجلسة");
}

remoteVideo.onclick = () => {
    isFullscreen = !isFullscreen;
    document.body.classList.toggle("fullscreen-mode", isFullscreen);
};

socket.on("connect", () => {
    console.log("Connected to server:", socket.id);
});

socket.on("user-joined", async () => {
    try {
        if (!isCreator || !roomId) {
            return;
        }

        await startOfferIfNeeded();
    } catch (error) {
        console.error(error);
        setStatus("تعذّر بدء الجلسة");
    }
});

socket.on("offer", async (offer) => {
    try {
        if (!roomId || !localStream) {
            return;
        }

        const pc = ensurePeerConnection();
        await pc.setRemoteDescription(offer);
        await addTracksToPeerConnection();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { roomId, answer });
        await drainPendingCandidates();
        setStatus("تم الاتصال بالطرف الآخر");
    } catch (error) {
        console.error(error);
        setStatus("تعذّر إكمال الاتصال");
    }
});

socket.on("answer", async (answer) => {
    try {
        if (!peerConnection) {
            return;
        }

        await peerConnection.setRemoteDescription(answer);
        await drainPendingCandidates();
        setStatus("تم الاتصال بالطرف الآخر");
    } catch (error) {
        console.error(error);
        setStatus("تعذّر إكمال الاتصال");
    }
});

socket.on("ice-candidate", async (candidate) => {
    try {
        if (!peerConnection) {
            pendingCandidates.push(candidate);
            return;
        }

        if (peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(candidate);
        } else {
            pendingCandidates.push(candidate);
        }
    } catch (error) {
        console.error(error);
    }
});

socket.on("room-ended", () => {
    resetSessionState("تم إنهاء الجلسة");
});

socket.on("peer-left", () => {
    resetSessionState("غادر الطرف الآخر الجلسة");
});

cameraBtn.onclick = async () => {
    try {
        await createLocalStream();
        setStatus("الكاميرا والميكروفون يعملان ✅");

        if (inviteRoomId && !roomId) {
            joinInput.value = inviteRoomId.toUpperCase();
            joinRoom();
        }
    } catch (error) {
        console.error(error);
        setStatus("تعذّر تشغيل الكاميرا أو الميكروفون");
    }
};

async function createRoom() {
    try {
        await createLocalStream();
    } catch (error) {
        console.error(error);
        setStatus("شغّل الكاميرا أولًا");
        return;
    }

    socket.emit("create-room", async (result) => {
        if (!result || !result.success) {
            setStatus("تعذّر إنشاء الجلسة");
            return;
        }

        isCreator = true;
        roomId = result.roomId;
        sessionCodeEl.innerText = roomId;

        const inviteLink = new URL(window.location.href);
        inviteLink.search = "";
        inviteLink.searchParams.set("room", roomId);

        setStatus("تم إنشاء الجلسة ✅");
        sessionArea.style.display = "block";

        let inviteArea = document.getElementById("inviteArea");
        if (!inviteArea) {
            inviteArea = document.createElement("div");
            inviteArea.id = "inviteArea";
            inviteArea.style.marginTop = "12px";
            sessionArea.appendChild(inviteArea);
        }

        inviteArea.innerHTML = `
            <p>رابط الدعوة:</p>
            <input id="inviteLink" readonly>
            <button id="copyInviteBtn">نسخ رابط الدعوة</button>
            <button id="shareInviteBtn">مشاركة عبر واتساب</button>
        `;

        document.getElementById("inviteLink").value = inviteLink.toString();

        document.getElementById("copyInviteBtn").onclick = async () => {
            try {
                await navigator.clipboard.writeText(inviteLink.toString());
                setStatus("تم نسخ رابط الدعوة ✅");
            } catch (error) {
                const field = document.getElementById("inviteLink");
                field.select();
                setStatus("حدّد الرابط وانسخه يدويًا");
            }
        };

        document.getElementById("shareInviteBtn").onclick = () => {
            const message = encodeURIComponent("انضم إليّ في جلسة شاهد معي:\n" + inviteLink.toString());
            window.open("https://wa.me/?text=" + message, "_blank");
        };

        ensurePeerConnection();
        await startOfferIfNeeded();
    });
}

async function joinRoom() {
    try {
        await createLocalStream();
    } catch (error) {
        console.error(error);
        setStatus("شغّل الكاميرا أولًا");
        return;
    }

    const requestedRoomId = joinInput.value.trim().toUpperCase();
    if (!requestedRoomId) {
        setStatus("أدخل رمز الجلسة أولًا");
        return;
    }

    socket.emit("join-room", requestedRoomId, (result) => {
        if (!result || !result.success) {
            setStatus(result?.message || "تعذّر الانضمام");
            return;
        }

        roomId = result.roomId;
        isCreator = false;
        setStatus("تم الانضمام، جارٍ الاتصال...");
        joinSection.style.display = "none";
        ensurePeerConnection();
    });
}

switchCameraBtn.onclick = async () => {
    if (!localStream) {
        setStatus("شغّل الكاميرا أولًا");
        return;
    }

    currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
    localStream.getTracks().forEach((track) => track.stop());

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode },
            audio: true
        });

        localVideo.srcObject = localStream;

        if (peerConnection) {
            const videoSender = peerConnection.getSenders().find((sender) => sender.track && sender.track.kind === "video");
            const audioSender = peerConnection.getSenders().find((sender) => sender.track && sender.track.kind === "audio");
            const newVideoTrack = localStream.getVideoTracks()[0] || null;
            const newAudioTrack = localStream.getAudioTracks()[0] || null;

            if (videoSender && newVideoTrack) {
                await videoSender.replaceTrack(newVideoTrack);
            }

            if (audioSender && newAudioTrack) {
                await audioSender.replaceTrack(newAudioTrack);
            }
        }

        setStatus(currentFacingMode === "user" ? "تم تشغيل الكاميرا الأمامية ✅" : "تم تشغيل الكاميرا الخلفية ✅");
    } catch (error) {
        console.error(error);
        setStatus("تعذّر تبديل الكاميرا");
    }
};

window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.endSession = endSession;
