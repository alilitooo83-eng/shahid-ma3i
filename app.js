const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000
});

const localVideo = document.getElementById("video");
const remoteVideo = document.getElementById("remoteVideo");
const status = document.getElementById("status");
const cameraBtn = document.getElementById("cameraBtn");
const switchCameraBtn = document.getElementById("switchCameraBtn");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinBtn = document.getElementById("joinBtn");
const sessionCodeEl = document.getElementById("sessionCode");
const sessionArea = document.getElementById("sessionArea");
const joinInput = document.getElementById("joinInput");
const joinSection = document.querySelector(".join");

const TURN_URL = (window.__TURN_URL__ || "").trim();
const TURN_USERNAME = (window.__TURN_USERNAME__ || "").trim();
const TURN_PASSWORD = (window.__TURN_PASSWORD__ || "").trim();

const inviteRoomId = new URLSearchParams(window.location.search).get("room");

let localStream = null;
let peerConnection = null;
let roomId = null;
let pendingCandidates = [];
let currentFacingMode = "user";
let isFullscreen = false;
let isCreator = false;
let sessionStarted = false;
let lastKnownRoomId = null;
let reconnecting = false;
let rtcConfig = null;
let pendingOffer = null;
let pendingAnswer = null;
let isCreatingRoom = false;
let isJoiningRoom = false;

function setStatus(message) {
  if (status) status.innerText = message;
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function getRtcConfig() {
  if (rtcConfig) return rtcConfig;

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

  rtcConfig = {
    iceServers,
    iceCandidatePoolSize: 10
  };

  return rtcConfig;
}

function cleanupPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onsignalingstatechange = null;
    try {
      peerConnection.close();
    } catch (error) {
      console.error("Failed to close peer connection", error);
    }
    peerConnection = null;
  }

  pendingCandidates = [];
  sessionStarted = false;
  pendingOffer = null;
  pendingAnswer = null;
  remoteVideo.srcObject = null;
}

function resetSessionState(message) {
  roomId = null;
  isCreator = false;
  lastKnownRoomId = null;
  sessionStarted = false;
  isCreatingRoom = false;
  isJoiningRoom = false;
  joinSection.hidden = true;
  sessionArea.hidden = true;
  if (message) setStatus(message);
  cleanupPeerConnection();
}

function createPeerConnection() {
  const pc = new RTCPeerConnection(getRtcConfig());

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && roomId) {
      socket.emit("ice-candidate", { roomId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = async () => {
    console.log("RTCPeerConnection state:", pc.connectionState);

    if (pc.connectionState === "connected") {
      setStatus("تم الاتصال بنجاح ✅");
      return;
    }

    if (pc.connectionState === "connecting") {
      setStatus("جارٍ الاتصال...");
      return;
    }

    if (pc.connectionState === "failed") {
      setStatus("فشل الاتصال، جارٍ إعادة إنشاء الاتصال...");
      await restartPeerConnection("connectionstate failed");
      return;
    }

    if (pc.connectionState === "disconnected") {
      setStatus("انقطع الاتصال، جارٍ إعادة المحاولة...");
    }

    if (pc.connectionState === "closed") {
      setStatus("تم إنهاء الجلسة");
    }
  };

  pc.oniceconnectionstatechange = async () => {
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      setStatus("مشكلة ICE، جارٍ إعادة إنشاء الاتصال...");
      await restartPeerConnection("ice state failed/disconnected");
    }
  };

  pc.onsignalingstatechange = () => {
    console.log("Signaling state:", pc.signalingState);
  };

  return pc;
}

async function addLocalTracks() {
  if (!peerConnection || !localStream) return;

  const senders = peerConnection.getSenders();
  const existingKinds = new Set(senders.map((sender) => sender.track && sender.track.kind).filter(Boolean));

  for (const track of localStream.getTracks()) {
    if (!existingKinds.has(track.kind)) {
      peerConnection.addTrack(track, localStream);
    }
  }
}

async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  peerConnection = createPeerConnection();
  await addLocalTracks();
  return peerConnection;
}

async function restartPeerConnection(reason) {
  const wasCreator = isCreator;
  const currentRoomId = roomId;
  const currentOffer = pendingOffer;
  const currentAnswer = pendingAnswer;

  cleanupPeerConnection();

  if (!currentRoomId) return;

  roomId = currentRoomId;
  peerConnection = createPeerConnection();
  await addLocalTracks();

  if (reason) {
    console.warn("Recreated RTCPeerConnection:", reason);
  }

  if (wasCreator && currentOffer === null) {
    await startOffer(true);
  }

  if (!wasCreator && currentAnswer) {
    try {
      await peerConnection.setRemoteDescription(currentAnswer);
      await drainPendingCandidates();
    } catch (error) {
      console.error("Failed to restore answer after restart", error);
    }
  }
}

async function createLocalStream() {
  if (localStream) return localStream;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode },
      audio: true
    });
    localVideo.srcObject = localStream;
    return localStream;
  } catch (error) {
    console.error("getUserMedia failed", error);
    setStatus("تعذّر تشغيل الكاميرا أو الميكروفون");
    throw error;
  }
}

async function drainPendingCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;

  while (pendingCandidates.length) {
    const candidate = pendingCandidates.shift();
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error("Failed to add ICE candidate", error);
    }
  }
}

async function startOffer(forceIceRestart = false) {
  if (!isCreator || !roomId) return;
  if (!peerConnection) await ensurePeerConnection();

  try {
    await addLocalTracks();
    const offer = await peerConnection.createOffer(forceIceRestart ? { iceRestart: true } : undefined);
    await peerConnection.setLocalDescription(offer);
    socket.emit("offer", { roomId, offer });
    sessionStarted = true;
  } catch (error) {
    console.error("Failed to create offer", error);
    setStatus("تعذّر إنشاء عرض الاتصال");
  }
}

function endSession(reason = "تم إنهاء الجلسة") {
  socket.emit("end-session");
  resetSessionState(reason);
}

remoteVideo.onclick = () => {
  isFullscreen = !isFullscreen;
  document.body.classList.toggle("fullscreen-mode", isFullscreen);
};

socket.on("connect", async () => {
  console.log("Connected to Socket.io:", socket.id);
  reconnecting = false;
  setStatus("متصل بالخادم ✅");

  if (lastKnownRoomId && !roomId) {
    roomId = lastKnownRoomId;
  }

  if (isCreator && roomId) {
    await startOffer(true);
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
    await startOffer(true);
  }
});

socket.io.on("reconnect_failed", () => {
  reconnecting = false;
  setStatus("فشلت إعادة الاتصال بالخادم");
});

socket.on("disconnect", (reason) => {
  console.warn("Socket disconnected:", reason);
  setStatus("انقطع اتصال Socket.io، جارٍ إعادة المحاولة...");
});

socket.on("connect_error", (error) => {
  console.error("Socket connect error", error);
  setStatus("خطأ في الاتصال بالخادم");
});

socket.on("user-joined", async () => {
  try {
    if (!isCreator || !roomId) return;
    await startOffer(false);
  } catch (error) {
    console.error("user-joined handler failed", error);
  }
});

socket.on("offer", async (offer) => {
  try {
    if (!offer || !roomId) return;
    pendingOffer = offer;
    await ensurePeerConnection();
    await peerConnection.setRemoteDescription(offer);
    await addLocalTracks();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("answer", { roomId, answer });
    await drainPendingCandidates();
    setStatus("تم الاتصال بالطرف الآخر");
  } catch (error) {
    console.error("Failed to process offer", error);
    setStatus("تعذّر إكمال الاتصال، جارٍ إعادة المحاولة...");
    await restartPeerConnection("offer handling failed");
  }
});

socket.on("answer", async (answer) => {
  try {
    if (!peerConnection) return;
    pendingAnswer = answer;
    await peerConnection.setRemoteDescription(answer);
    await drainPendingCandidates();
    setStatus("تم الاتصال بالطرف الآخر");
  } catch (error) {
    console.error("Failed to process answer", error);
    setStatus("تعذّر إكمال الاتصال، جارٍ إعادة المحاولة...");
    await restartPeerConnection("answer handling failed");
  }
});

socket.on("ice-candidate", async (candidate) => {
  try {
    if (!candidate) return;
    if (!peerConnection || !peerConnection.remoteDescription) {
      pendingCandidates.push(candidate);
      return;
    }
    await peerConnection.addIceCandidate(candidate);
  } catch (error) {
    console.error("Failed to add remote ICE candidate", error);
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
    console.error("Camera button failed", error);
  }
};

async function createRoom() {
  if (isCreatingRoom) return;
  isCreatingRoom = true;

  try {
    await createLocalStream();
  } catch (error) {
    isCreatingRoom = false;
    return;
  }

  socket.emit("create-room", async (result) => {
    isCreatingRoom = false;

    if (!result || !result.success) {
      setStatus("تعذّر إنشاء الجلسة");
      return;
    }

    isCreator = true;
    roomId = result.roomId;
    lastKnownRoomId = roomId;
    sessionCodeEl.innerText = roomId;
    sessionArea.hidden = false;
    joinSection.hidden = true;

    const inviteLink = new URL(window.location.href);
    inviteLink.search = "";
    inviteLink.searchParams.set("room", roomId);

    const inviteArea = document.getElementById("inviteArea");
    inviteArea.innerHTML = `
      <p>رابط الدعوة:</p>
      <input id="inviteLink" readonly value="${inviteLink.toString()}">
      <button id="copyInviteBtn" type="button">نسخ رابط الدعوة</button>
      <button id="shareInviteBtn" type="button">مشاركة عبر واتساب</button>
    `;

    document.getElementById("copyInviteBtn").onclick = async () => {
      try {
        await navigator.clipboard.writeText(inviteLink.toString());
        setStatus("تم نسخ رابط الدعوة ✅");
      } catch (error) {
        console.error("Clipboard copy failed", error);
        setStatus("انسخ الرابط يدويًا");
      }
    };

    document.getElementById("shareInviteBtn").onclick = () => {
      const message = encodeURIComponent(`انضم إليّ في جلسة شاهد معي:\n${inviteLink.toString()}`);
      window.open(`https://wa.me/?text=${message}`, "_blank");
    };

    setStatus("تم إنشاء الجلسة ✅");
    await ensurePeerConnection();
    await startOffer(false);
  });
}

async function joinRoom() {
  if (isJoiningRoom) return;
  isJoiningRoom = true;

  try {
    await createLocalStream();
  } catch (error) {
    isJoiningRoom = false;
    return;
  }

  const requestedRoomId = joinInput.value.trim().toUpperCase();
  if (!requestedRoomId) {
    isJoiningRoom = false;
    setStatus("أدخل رمز الجلسة أولًا");
    return;
  }

  socket.emit("join-room", requestedRoomId, async (result) => {
    isJoiningRoom = false;

    if (!result || !result.success) {
      setStatus((result && result.message) || "تعذّر الانضمام");
      return;
    }

    roomId = result.roomId;
    lastKnownRoomId = roomId;
    isCreator = false;
    sessionArea.hidden = false;
    joinSection.hidden = true;
    sessionStarted = false;
    setStatus("تم الانضمام، جارٍ انتظار العرض...");
    await ensurePeerConnection();
    await drainPendingCandidates();
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

    setStatus("تم تبديل الكاميرا ✅");
  } catch (error) {
    console.error("Camera switch failed", error);
    setStatus("تعذّر تبديل الكاميرا");
  }
};

createRoomBtn.onclick = createRoom;
joinBtn.onclick = joinRoom;

joinInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom();
});

window.addEventListener("beforeunload", () => {
  if (peerConnection) {
    try {
      socket.emit("end-session");
    } catch (error) {
      console.error("Failed to end session on unload", error);
    }
  }
  cleanupPeerConnection();
  stopTracks(localStream);
});

if (inviteRoomId) {
  joinSection.hidden = false;
  joinInput.value = inviteRoomId.toUpperCase();
}
