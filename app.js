const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000
});

const localVideo = document.getElementById("video");
const remoteVideo = document.getElementById("remoteVideo");
const statusEl = document.getElementById("status");
const cameraBtn = document.getElementById("cameraBtn");
const switchCameraBtn = document.getElementById("switchCameraBtn");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinBtn = document.getElementById("joinBtn");
const sessionCodeEl = document.getElementById("sessionCode");
const sessionArea = document.getElementById("sessionArea");
const joinInput = document.getElementById("joinInput");
const joinSection = document.querySelector(".join");
const inviteArea = document.getElementById("inviteArea");

const TURN_URL = (window.__TURN_URL__ || "").trim();
const TURN_USERNAME = (window.__TURN_USERNAME__ || "").trim();
const TURN_PASSWORD = (window.__TURN_PASSWORD__ || "").trim();
const inviteRoomId = new URLSearchParams(window.location.search).get("room");

const SESSION_STATE = Object.freeze({
  IDLE: "IDLE",
  LOCAL_READY: "LOCAL_READY",
  CREATING_ROOM: "CREATING_ROOM",
  JOINING_ROOM: "JOINING_ROOM",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  RECOVERING: "RECOVERING",
  ENDED: "ENDED",
  ERROR: "ERROR"
});

const SIGNAL_TIMEOUT_MS = 12000;
const ICE_FLUSH_TIMEOUT_MS = 5000;
const RECOVERY_DELAY_MS = 1200;
const MAX_RETRY_COUNT = 3;

let state = SESSION_STATE.IDLE;
let localStream = null;
let peerConnection = null;
let roomId = null;
let sessionToken = null;
let isCreator = false;
let currentFacingMode = "user";
let isFullscreen = false;
let isCreatingRoom = false;
let isJoiningRoom = false;
let hasRemotePeer = false;
let offerInFlight = false;
let endSessionRequested = false;
let rtcConfig = null;
let queuedCandidates = [];
let seenCandidateKeys = new Set();
let pendingRemoteDescription = null;
let pendingSessionRecovery = null;
let reconnectTimer = null;
let offerTimer = null;
let negotiatedOnce = false;
let lastKnownRoomId = null;
let lastKnownToken = null;
let retryCounter = 0;
let localStreamReady = false;
let remoteDescriptionApplied = false;
let allowNegotiation = false;

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function emitWithSession(event, payload = {}, callback) {
  if (!roomId || !sessionToken) {
    if (typeof callback === "function") callback({ success: false, message: "لا توجد جلسة نشطة" });
    return false;
  }

  socket.emit(event, { ...payload, roomId, sessionToken }, callback);
  return true;
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
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

  rtcConfig = { iceServers, iceCandidatePoolSize: 10 };
  return rtcConfig;
}

function setSessionState(nextState, message) {
  state = nextState;
  if (message) setStatus(message);
}

function clearTimer(timerRef) {
  if (timerRef) clearTimeout(timerRef);
}

function cancelTimers() {
  clearTimer(reconnectTimer);
  clearTimer(offerTimer);
  reconnectTimer = null;
  offerTimer = null;
}

function clearCandidateQueue() {
  queuedCandidates = [];
  seenCandidateKeys = new Set();
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
      console.error("Failed to close RTCPeerConnection", error);
    }
  }

  peerConnection = null;
  pendingRemoteDescription = null;
  remoteDescriptionApplied = false;
  negotiatedOnce = false;
  offerInFlight = false;
  allowNegotiation = false;
  clearCandidateQueue();

  if (remoteVideo) remoteVideo.srcObject = null;
}

function cleanup() {
  cancelTimers();
  cleanupPeerConnection();
}

function resetSession(message = "تمت إعادة تعيين الجلسة") {
  cleanup();
  roomId = null;
  sessionToken = null;
  isCreator = false;
  hasRemotePeer = false;
  endSessionRequested = false;
  isCreatingRoom = false;
  isJoiningRoom = false;
  lastKnownRoomId = null;
  lastKnownToken = null;
  retryCounter = 0;
  setSessionState(SESSION_STATE.IDLE, message);
  if (sessionArea) sessionArea.hidden = true;
  if (joinSection) joinSection.hidden = false;
}

function getCandidateKey(candidate) {
  if (!candidate) return "";
  const raw = candidate.candidate || candidate;
  return [raw.candidate, raw.sdpMid, raw.sdpMLineIndex].join("|");
}

function enqueueCandidate(candidate) {
  const key = getCandidateKey(candidate);
  if (!key || seenCandidateKeys.has(key)) return;
  seenCandidateKeys.add(key);
  queuedCandidates.push(candidate);
}

async function flushCandidateQueue() {
  if (!peerConnection || !peerConnection.remoteDescription) return;

  const start = Date.now();
  while (queuedCandidates.length > 0) {
    if (Date.now() - start > ICE_FLUSH_TIMEOUT_MS) {
      console.warn("ICE queue flush timed out");
      break;
    }

    const candidate = queuedCandidates.shift();
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error("Failed to add queued ICE candidate", error);
    }
  }
}

function createPeerConnection() {
  const pc = new RTCPeerConnection(getRtcConfig());

  pc.ontrack = (event) => {
    const stream = event.streams && event.streams[0];
    if (stream && remoteVideo) remoteVideo.srcObject = stream;
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate || !roomId || !sessionToken) return;
    emitWithSession("ice-candidate", { candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log("connectionState:", pc.connectionState);

    if (pc.connectionState === "connected") {
      setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بنجاح ✅");
      retryCounter = 0;
      return;
    }

    if (pc.connectionState === "connecting") {
      setSessionState(SESSION_STATE.CONNECTING, "جارٍ الاتصال...");
      return;
    }

    if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
      scheduleRecovery(`connection:${pc.connectionState}`);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log("iceConnectionState:", pc.iceConnectionState);

    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      scheduleRecovery(`ice:${pc.iceConnectionState}`);
    }
  };

  pc.onsignalingstatechange = () => {
    console.log("signalingState:", pc.signalingState);

    if (pc.signalingState === "closed" || pc.signalingState === "stable") return;
    if (pc.signalingState === "have-local-offer" || pc.signalingState === "have-remote-offer") return;
    if (pc.signalingState === "closed") scheduleRecovery("signaling:closed");
  };

  return pc;
}

async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  peerConnection = createPeerConnection();
  await addLocalTracks();
  return peerConnection;
}

async function addLocalTracks() {
  if (!peerConnection || !localStream) return;

  const existingKinds = new Set(
    peerConnection.getSenders().map((sender) => sender.track && sender.track.kind).filter(Boolean)
  );

  for (const track of localStream.getTracks()) {
    if (!existingKinds.has(track.kind)) {
      peerConnection.addTrack(track, localStream);
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
    localStreamReady = true;
    if (localVideo) localVideo.srcObject = localStream;
    setSessionState(SESSION_STATE.LOCAL_READY, "تم تشغيل الكاميرا والميكروفون ✅");
    return localStream;
  } catch (error) {
    console.error("getUserMedia failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر تشغيل الكاميرا أو الميكروفون");
    throw error;
  }
}

function clearOfferTimeout() {
  clearTimer(offerTimer);
  offerTimer = null;
}

function scheduleOfferTimeout() {
  clearOfferTimeout();
  offerTimer = setTimeout(() => {
    if (isCreator && roomId && !negotiatedOnce) {
      console.warn("Offer timeout reached");
      scheduleRecovery("offer-timeout");
    }
  }, SIGNAL_TIMEOUT_MS);
}

async function createOffer(forceIceRestart = false) {
  if (!isCreator || !peerConnection || !roomId || offerInFlight || endSessionRequested) return;
  if (peerConnection.signalingState === "have-local-offer") return;

  offerInFlight = true;
  scheduleOfferTimeout();

  try {
    await addLocalTracks();
    const offer = await peerConnection.createOffer(forceIceRestart ? { iceRestart: true } : undefined);
    await peerConnection.setLocalDescription(offer);
    emitWithSession("offer", { offer });
    negotiatedOnce = true;
    setSessionState(SESSION_STATE.CONNECTING, "تم إرسال عرض الاتصال...");
  } catch (error) {
    console.error("createOffer failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر إنشاء عرض الاتصال");
    scheduleRecovery("createOffer-failed");
  } finally {
    offerInFlight = false;
  }
}

async function handleIncomingOffer(offerPayload) {
  if (!offerPayload || !offerPayload.offer) return;
  if (endSessionRequested) return;

  try {
    await ensurePeerConnection();
    pendingRemoteDescription = offerPayload.offer;
    await peerConnection.setRemoteDescription(offerPayload.offer);
    remoteDescriptionApplied = true;
    await addLocalTracks();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    emitWithSession("answer", { answer });
    await flushCandidateQueue();
    setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بالطرف الآخر ✅");
  } catch (error) {
    console.error("handleIncomingOffer failed", error);
    scheduleRecovery("incoming-offer-failed");
  }
}

async function handleIncomingAnswer(answerPayload) {
  if (!answerPayload || !answerPayload.answer || !peerConnection || endSessionRequested) return;

  try {
    if (peerConnection.signalingState === "stable" || remoteDescriptionApplied) {
      await peerConnection.setRemoteDescription(answerPayload.answer);
      remoteDescriptionApplied = true;
      await flushCandidateQueue();
      setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بالطرف الآخر ✅");
    }
  } catch (error) {
    console.error("handleIncomingAnswer failed", error);
    scheduleRecovery("incoming-answer-failed");
  }
}

async function handleIncomingCandidate(candidatePayload) {
  if (!candidatePayload || !candidatePayload.candidate || endSessionRequested) return;

  try {
    if (!peerConnection || !peerConnection.remoteDescription) {
      enqueueCandidate(candidatePayload.candidate);
      return;
    }
    await peerConnection.addIceCandidate(candidatePayload.candidate);
  } catch (error) {
    console.error("Failed to handle ICE candidate", error);
  }
}

function scheduleRecovery(reason) {
  if (endSessionRequested) return;
  if (pendingSessionRecovery) return;

  setSessionState(SESSION_STATE.RECOVERING, `جارٍ استعادة الاتصال (${reason})...`);
  pendingSessionRecovery = setTimeout(async () => {
    pendingSessionRecovery = null;
    await recoverConnection(reason);
  }, RECOVERY_DELAY_MS);
}

async function recoverConnection(reason) {
  if (endSessionRequested || !roomId) return;
  if (retryCounter >= MAX_RETRY_COUNT) {
    setSessionState(SESSION_STATE.ERROR, "فشلت إعادة المحاولة عدة مرات");
    return;
  }

  retryCounter += 1;
  const savedRoomId = roomId;
  const savedToken = sessionToken;
  const savedCreator = isCreator;
  const savedStream = localStream;

  cleanupPeerConnection();
  roomId = savedRoomId;
  sessionToken = savedToken;
  isCreator = savedCreator;
  localStream = savedStream;
  if (localStream && localVideo) localVideo.srcObject = localStream;

  await ensurePeerConnection();

  if (isCreator) {
    await createOffer(true);
  } else if (pendingRemoteDescription) {
    try {
      await peerConnection.setRemoteDescription(pendingRemoteDescription);
      await addLocalTracks();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      emitWithSession("answer", { answer });
    } catch (error) {
      console.error("recoverConnection failed to restore answer", error);
    }
  }

  await flushCandidateQueue();
  setSessionState(SESSION_STATE.CONNECTING, "تمت إعادة إنشاء الاتصال...");
}

function markEndSessionRequested() {
  if (endSessionRequested) return true;
  endSessionRequested = true;
  return false;
}

function endSession(message = "تم إنهاء الجلسة") {
  if (markEndSessionRequested()) return;
  emitWithSession("end-session", {}, () => {});
  resetSession(message);
}

async function switchCamera() {
  if (!localStream) return;

  currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
  stopTracks(localStream);
  localStream = null;
  localStreamReady = false;

  try {
    await createLocalStream();
    if (peerConnection) {
      for (const sender of peerConnection.getSenders()) {
        if (sender.track && sender.track.kind === "video" && localStream) {
          const newTrack = localStream.getVideoTracks()[0];
          if (newTrack) sender.replaceTrack(newTrack);
        }
      }
    }
    setStatus(`تم تبديل الكاميرا إلى ${currentFacingMode === "user" ? "الأمامية" : "الخلفية"}`);
  } catch (error) {
    console.error("switchCamera failed", error);
  }
}

function applyInviteIfNeeded() {
  if (!inviteRoomId || !joinInput) return;
  joinInput.value = inviteRoomId.toUpperCase();
}

async function createRoom() {
  if (isCreatingRoom) return;
  isCreatingRoom = true;

  try {
    await createLocalStream();
    socket.emit("create-room", async (result) => {
      isCreatingRoom = false;
      if (!result || !result.success) {
        setSessionState(SESSION_STATE.ERROR, (result && result.message) || "تعذّر إنشاء الجلسة");
        return;
      }

      roomId = result.roomId;
      sessionToken = result.sessionToken;
      lastKnownRoomId = roomId;
      lastKnownToken = sessionToken;
      isCreator = true;
      hasRemotePeer = false;
      sessionCodeEl.textContent = roomId;
      sessionArea.hidden = false;
      joinSection.hidden = true;
      setSessionState(SESSION_STATE.CREATING_ROOM, "تم إنشاء الجلسة ✅");

      const inviteLink = new URL(window.location.href);
      inviteLink.searchParams.set("room", roomId);

      if (inviteArea) {
        inviteArea.innerHTML = `
          <p>رابط الدعوة:</p>
          <input id="inviteLink" readonly value="${inviteLink.toString()}">
          <button id="copyInviteBtn" type="button">نسخ رابط الدعوة</button>
          <button id="shareInviteBtn" type="button">مشاركة عبر واتساب</button>
        `;

        const copyInviteBtn = document.getElementById("copyInviteBtn");
        const shareInviteBtn = document.getElementById("shareInviteBtn");
        if (copyInviteBtn) {
          copyInviteBtn.onclick = async () => {
            try {
              await navigator.clipboard.writeText(inviteLink.toString());
              setStatus("تم نسخ رابط الدعوة ✅");
            } catch (error) {
              console.error("Clipboard copy failed", error);
              setStatus("انسخ الرابط يدويًا");
            }
          };
        }
        if (shareInviteBtn) {
          shareInviteBtn.onclick = () => {
            const message = encodeURIComponent(`انضم إليّ في جلسة شاهد معي:\n${inviteLink.toString()}`);
            window.open(`https://wa.me/?text=${message}`, "_blank");
          };
        }
      }

      await ensurePeerConnection();
      await createOffer(false);
    });
  } catch (error) {
    isCreatingRoom = false;
    console.error("createRoom failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر إنشاء الجلسة");
  }
}

async function joinRoom() {
  if (isJoiningRoom) return;
  isJoiningRoom = true;

  try {
    await createLocalStream();
    const requestedRoomId = (joinInput && joinInput.value ? joinInput.value : "").trim().toUpperCase();
    if (!requestedRoomId) {
      setSessionState(SESSION_STATE.ERROR, "أدخل رمز الجلسة أولًا");
      isJoiningRoom = false;
      return;
    }

    socket.emit("join-room", { roomId: requestedRoomId, sessionToken: requestedRoomId }, async (result) => {
      isJoiningRoom = false;
      if (!result || !result.success) {
        setSessionState(SESSION_STATE.ERROR, (result && result.message) || "تعذّر الانضمام");
        return;
      }

      roomId = result.roomId;
      sessionToken = result.sessionToken;
      lastKnownRoomId = roomId;
      lastKnownToken = sessionToken;
      isCreator = false;
      hasRemotePeer = true;
      sessionArea.hidden = false;
      sessionCodeEl.textContent = roomId;
      setSessionState(SESSION_STATE.JOINING_ROOM, "تم الانضمام بنجاح ✅");

      await ensurePeerConnection();
      await flushCandidateQueue();
    });
  } catch (error) {
    isJoiningRoom = false;
    console.error("joinRoom failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر الانضمام للجلسة");
  }
}

function bindUi() {
  if (cameraBtn) cameraBtn.onclick = createLocalStream;
  if (switchCameraBtn) switchCameraBtn.onclick = switchCamera;
  if (createRoomBtn) createRoomBtn.onclick = createRoom;
  if (joinBtn) joinBtn.onclick = joinRoom;

  if (remoteVideo) {
    remoteVideo.onclick = () => {
      isFullscreen = !isFullscreen;
      document.body.classList.toggle("fullscreen-mode", isFullscreen);
    };
  }
}

function bindSocketEvents() {
  socket.on("connect", async () => {
    setStatus("متصل بالخادم ✅");
    if (lastKnownRoomId && lastKnownToken && !roomId) {
      roomId = lastKnownRoomId;
      sessionToken = lastKnownToken;
    }
    if (isCreator && roomId) {
      await createOffer(true);
    }
  });

  socket.on("disconnect", (reason) => {
    console.warn("Socket disconnected:", reason);
    setStatus("انقطع اتصال الخادم، جارٍ إعادة المحاولة...");
  });

  socket.on("connect_error", (error) => {
    console.error("Socket connect error", error);
    setStatus("خطأ في الاتصال بالخادم");
  });

  socket.io.on("reconnect_attempt", () => {
    setStatus("جارٍ إعادة الاتصال بالخادم...");
  });

  socket.io.on("reconnect", async () => {
    setStatus("تمت إعادة الاتصال بالخادم ✅");
    if (roomId && sessionToken && peerConnection && isCreator) {
      await createOffer(true);
    }
  });

  socket.io.on("reconnect_failed", () => {
    setStatus("فشلت إعادة الاتصال بالخادم");
  });

  socket.on("user-joined", async () => {
    hasRemotePeer = true;
    if (isCreator) {
      await createOffer(false);
    }
  });

  socket.on("offer", async (payload) => {
    await handleIncomingOffer(payload);
  });

  socket.on("answer", async (payload) => {
    await handleIncomingAnswer(payload);
  });

  socket.on("ice-candidate", async (payload) => {
    await handleIncomingCandidate(payload);
  });

  socket.on("room-ended", () => {
    resetSession("تم إنهاء الجلسة من الطرف الآخر");
  });

  socket.on("peer-left", () => {
    if (!endSessionRequested) {
      resetSession("غادر الطرف الآخر الجلسة");
    }
  });
}

async function initialize() {
  bindUi();
  bindSocketEvents();
  applyInviteIfNeeded();
  setStatus("جاهز للبدء");

  if (inviteRoomId && joinInput) {
    joinInput.value = inviteRoomId.toUpperCase();
  }
}

window.addEventListener("beforeunload", () => {
  cleanup();
  stopTracks(localStream);
});

window.endSession = endSession;
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.recoverConnection = recoverConnection;
window.resetSession = resetSession;
window.emitWithSession = emitWithSession;
window.setStatus = setStatus;

initialize().catch((error) => {
  console.error("Initialization failed", error);
  setStatus("فشل تهيئة التطبيق");
});