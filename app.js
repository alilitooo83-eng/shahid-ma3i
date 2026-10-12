const socket = io({
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000
});

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

const TURN_URL = (window.__TURN_URL__ || "").trim();
const TURN_USERNAME = (window.__TURN_USERNAME__ || "").trim();
const TURN_PASSWORD = (window.__TURN_PASSWORD__ || "").trim();

let localStream = null;
let peerConnection = null;
let roomId = null;
let pendingCandidates = [];
let currentFacingMode = "user";
let isFullscreen = false;
let isCreator = false;
let sessionStarted = false;
let shouldCreateOffer = false;
let lastKnownRoomId = null;
let reconnecting = false;

const inviteRoomId = new URLSearchParams(window.location.search).get("room");

function buildRtcConfig() {
    const iceServers = [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
    ];

    if (TURN_URL && TURN_USERNAME && TURN_PASSWORD) {
        iceServers.push({
            urls: TURN_URL,
            username: TURN_USERNAME,
            credential: TURN_PASSWORD
        });
    }

    return {
        iceServers,
        iceCandidatePoolSize: 10
    };
}

function setStatus(message) {
    if (status) status.innerText = message;
}

function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
}

function cleanupPeerConnection() {
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.onicegatheringstatechange = null;
        peerConnection.onsignalingstatechange = null;
        try { peerConnection.close(); } catch (_) {}
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
    lastKnownRoomId = null;
    joinSection.style.display = "none";
    if (message) setStatus(message);
    cleanupPeerConnection();
}

async function recreatePeerConnection(reason = "") {
    const previousRoomId = roomId;
    cleanupPeerConnection();
    if (!previousRoomId) return;
    roomId = previousRoomId;
    peerConnection = new RTCPeerConnection(buildRtcConfig());
    wirePeerConnectionEvents();
    await addTracksToPeerConnection();
    if (reason) console.warn("Recreated PeerConnection:", reason);
}

function wirePeerConnectionEvents() {
    if (!peerConnection) return;

    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onconnectionstatechange = async () => {
        console.log("Connection:", peerConnection.connectionState);
        if (peerConnection.connectionState === "connected") {
            setStatus("تم الاتصال بنجاح ✅");
        } else if (peerConnection.connectionState === "connecting") {
            setStatus("جارٍ الاتصال...");
        } else if (peerConnection.connectionState === "failed") {
            setStatus("فشل ICE، جارٍ إعادة المحاولة...");
            const currentRoom = roomId;
            await recreatePeerConnection("connectionstate failed");
            if (currentRoom && isCreator) {
                await startOfferIfNeeded(true);
            }
        } else if (peerConnection.connectionState === "disconnected") {
            setStatus("انقطع الاتصال، جارٍ إعادة الاتصال...");
        } else if (peerConnection.connectionState === "closed") {
            setStatus("تم إنهاء الجلسة");
        }
    };

    peerConnection.oniceconnectionstatechange = async () => {
        if (!peerConnection) return;
        if (peerConnection.iceConnectionState === "failed") {
            setStatus("فشل ICE، جارٍ إعادة إنشاء الاتصال...");
            const currentRoom = roomId;
            await recreatePeerConnection("iceConnectionState failed");
            if (currentRoom && isCreator) {
                await startOfferIfNeeded(true);
            }
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && roomId) {
            socket.emit("ice-candidate", { roomId, candidate: event.candidate });
        }
    };
}

function ensurePeerConnection() {
    if (peerConnection) return peerConnection;
    peerConnection = new RTCPeerConnection(buildRtcConfig());
    wirePeerConnectionEvents();
    if (localStream) {
        localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
    }
    return peerConnection;
}

async function createLocalStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode },
        audio: true
    });
    localVideo.srcObject = localStream;
    return localStream;
}

async function addTracksToPeerConnection() {
    if (!peerConnection || !localStream) return;

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

async function startOfferIfNeeded(force = false) {
    if (!isCreator || !roomId) return;
    if (sessionStarted && !force) return;

    const pc = ensurePeerConnection();
    await addTracksToPeerConnection();
    const offer = await pc.createOffer(force ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    socket.emit("offer", { roomId, offer });
    sessionStarted = true;
}

async function drainPendingCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    while (pendingCandidates.length) {
        const candidate = pendingCandidates.shift();
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (error) {
            console.error(error);
        }
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

socket.on("connect", async () => {
    console.log("Connected to server:", socket.id);
    reconnecting = false;
    setStatus("متصل بالخادم ✅");
    if (lastKnownRoomId && !roomId) {
        roomId = lastKnownRoomId;
    }
    if (isCreator && roomId) {
        await startOfferIfNeeded(true);
    }
});

socket.io.on("reconnect_attempt", () => {
    reconnecting = true;
    setStatus("جارٍ إعادة الاتصال بالخادم...");
});

socket.io.on("reconnect", async () => {
    reconnecting = false;
    setStatus("تمت إعادة الاتصال بالخادم ✅");
    if (lastKnownRoomId && !roomId) {
        roomId = lastKnownRoomId;
    }
    if (isCreator && roomId) {
        await startOfferIfNeeded(true);
    }
});

socket.io.on("reconnect_failed", () => {
    reconnecting = false;
    setStatus("فشلت إعادة الاتصال بالخادم");
});

socket.on("disconnect", () => {
    setStatus("انقطع اتصال Socket.io، جارٍ إعادة المحاولة...");
});

socket.on("user-joined", async () => {
    try {
        if (!isCreator || !roomId) return;
        await startOfferIfNeeded();
    } catch (error) {
        console.error(error);
        setStatus("تعذّر بدء الجلسة");
    }
});

socket.on("offer", async (offer) => {
    try {
        if (!roomId) return;
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
        await recreatePeerConnection("offer handling failed");
    }
});

socket.on("answer", async (answer) => {
    try {
        if (!peerConnection) return;
        await peerConnection.setRemoteDescription(answer);
        await drainPendingCandidates();
        setStatus("تم الاتصال بالطرف الآخر");
    } catch (error) {
        console.error(error);
        setStatus("تعذّر إكمال الاتصال");
        await recreatePeerConnection("answer handling failed");
    }
});

socket.on("ice-candidate", async (candidate) => {
    try {
        if (!peerConnection || !peerConnection.remoteDescription) {
            pendingCandidates.push(candidate);
            return;
        }
        await peerConnection.addIceCandidate(candidate);
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
        lastKnownRoomId = roomId;
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
            } catch (_) {
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
        lastKnownRoomId = roomId;
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
    stopTracks(localStream);

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

            if (videoSender && newVideoTrack) await videoSender.replaceTrack(newVideoTrack);
            if (audioSender && newAudioTrack) await audioSender.replaceTrack(newAudioTrack);
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
