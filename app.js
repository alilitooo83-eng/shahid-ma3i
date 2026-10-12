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
const endRoomBtn = document.getElementById("endRoomBtn");
const sessionCodeEl = document.getElementById("sessionCode");
const sessionArea = document.getElementById("sessionArea");
const joinInput = document.getElementById("joinInput");
const joinSection = document.querySelector(".join");
const inviteArea = document.getElementById("inviteArea");
const inviteLinkEl = document.getElementById("inviteLink");
const copyInviteBtn = document.getElementById("copyInviteBtn");

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
let pendingSessionRecovery = null;
let reconnectTimer = null;
let offerTimer = null;
let negotiatedOnce = false;
let retryCounter = 0;
let remoteDescriptionApplied = false;

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function setSessionState(nextState, message) {
  state = nextState;
  if (message) setStatus(message);
}

function safeAck(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

function clearTimer(timerRef) {
  if (timerRef) clearTimeout(timerRef);
}

function cancelTimers() {
  clearTimer(reconnectTimer);
  clearTimer(offerTimer);
  clearTimer(pendingSessionRecovery);
  reconnectTimer = null;
  offerTimer = null;
  pendingSessionRecovery = null;
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

function emitWithSession(event, payload = {}, callback) {
  if (!roomId || !sessionToken) {
    safeAck(callback, { success: false, message: "لا توجد جلسة نشطة" });
    return false;
  }

  socket.emit(event, { ...payload, roomId, sessionToken }, callback);
  return true;
}

function getCandidateKey(candidate) {
  if (!candidate) return "";
  return [candidate.candidate || "", candidate.sdpMid || "", candidate.sdpMLineIndex ?? ""].join("|");
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
    if (Date.now() - start > ICE_FLUSH_TIMEOUT_MS) break;
    const candidate = queuedCandidates.shift();
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error("Failed to add queued ICE candidate", error);
    }
  }
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
  negotiatedOnce = false;
  offerInFlight = false;
  remoteDescriptionApplied = false;
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
  retryCounter = 0;
  if (sessionCodeEl) sessionCodeEl.textContent = "--------";
  if (inviteArea) inviteArea.hidden = true;
  if (inviteLinkEl) {
    inviteLinkEl.textContent = "";
    inviteLinkEl.href = "#";
  }
  if (sessionArea) sessionArea.hidden = true;
  if (joinSection) joinSection.hidden = false;
  setSessionState(SESSION_STATE.IDLE, message);
}

async function createLocalStream() {
  if (localStream) return localStream;

  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });
  if (localVideo) localVideo.srcObject = localStream;
  setSessionState(SESSION_STATE.LOCAL_READY, "تم تشغيل الكاميرا والميكروفون ✅");
  return localStream;
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

function createInviteLink(room) {
  return `${window.location.origin}/?room=${encodeURIComponent(room)}`;
}

function showInviteLink(room) {
  const inviteLink = createInviteLink(room);
  if (inviteLinkEl) {
    inviteLinkEl.href = inviteLink;
    inviteLinkEl.textContent = inviteLink;
    inviteLinkEl.target = "_blank";
  }
  if (inviteArea) inviteArea.hidden = false;
  return inviteLink;
}

async function copyInviteLinkToClipboard(link) {
  if (!link) return false;
  try {
    await navigator.clipboard.writeText(link);
    setStatus("تم نسخ رابط الدعوة ✅");
    return true;
  } catch (error) {
    console.error("Failed to copy invite link", error);
    setStatus("تعذّر نسخ الرابط، انسخه يدويًا من الشاشة");
    return false;
  }
}

function createPeerConnection() {
  const pc = new RTCPeerConnection(getRtcConfig());

  pc.ontrack = (event) => {
    const stream = event.streams && event.streams[0];
    if (stream && remoteVideo) remoteVideo.srcObject = stream;
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate || !roomId || !sessionToken || endSessionRequested) return;
    emitWithSession("ice-candidate", { candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بنجاح ✅");
      retryCounter = 0;
      return;
    }

    if (pc.connectionState === "connecting") {
      setSessionState(SESSION_STATE.CONNECTING, "جارٍ الاتصال...");
      return;
    }

    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      scheduleRecovery(`connection:${pc.connectionState}`);
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (["failed", "disconnected"].includes(pc.iceConnectionState)) {
      scheduleRecovery(`ice:${pc.iceConnectionState}`);
    }
  };

  pc.onsignalingstatechange = () => {
    if (pc.signalingState === "closed") {
      scheduleRecovery("signaling:closed");
    }
  };

  return pc;
}

async function ensurePeerConnection() {
  if (!peerConnection) {
    peerConnection = createPeerConnection();
    await addLocalTracks();
  }
  return peerConnection;
}

async function createOffer(forceIceRestart = false) {
  if (!isCreator || !peerConnection || !roomId || offerInFlight || endSessionRequested) return;
  if (peerConnection.signalingState === "have-local-offer") return;

  offerInFlight = true;
  clearTimer(offerTimer);
  offerTimer = setTimeout(() => {
    if (isCreator && roomId && !negotiatedOnce) scheduleRecovery("offer-timeout");
  }, SIGNAL_TIMEOUT_MS);

  try {
    await addLocalTracks();
    const offer = await peerConnection.createOffer(forceIceRestart ? { iceRestart: true } : undefined);
    await peerConnection.setLocalDescription(offer);
    emitWithSession("offer", { offer });
    negotiatedOnce = true;
    setSessionState(SESSION_STATE.CONNECTING, "تم إرسال عرض الاتصال...");
  } catch (error) {
    console.error("createOffer failed", error);
    scheduleRecovery("createOffer-failed");
  } finally {
    offerInFlight = false;
  }
}

async function handleIncomingOffer(payload) {
  if (!payload || !payload.offer || endSessionRequested) return;
  await ensurePeerConnection();
  try {
    await peerConnection.setRemoteDescription(payload.offer);
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

async function handleIncomingAnswer(payload) {
  if (!payload || !payload.answer || !peerConnection || endSessionRequested) return;
  try {
    if (peerConnection.signalingState !== "closed" && !remoteDescriptionApplied) {
      await peerConnection.setRemoteDescription(payload.answer);
      remoteDescriptionApplied = true;
      await flushCandidateQueue();
      setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بالطرف الآخر ✅");
    }
  } catch (error) {
    console.error("handleIncomingAnswer failed", error);
    scheduleRecovery("incoming-answer-failed");
  }
}

async function handleIncomingCandidate(payload) {
  if (!payload || !payload.candidate || endSessionRequested) return;
  try {
    if (!peerConnection || !peerConnection.remoteDescription) {
      enqueueCandidate(payload.candidate);
      return;
    }
    await peerConnection.addIceCandidate(payload.candidate);
  } catch (error) {
    console.error("Failed to handle ICE candidate", error);
  }
}

function scheduleRecovery(reason) {
  if (endSessionRequested || pendingSessionRecovery) return;
  setSessionState(SESSION_STATE.RECOVERING, `جارٍ استعادة الاتصال (${reason})...`);
  pendingSessionRecovery = setTimeout(async () => {
    pendingSessionRecovery = null;
    await recoverConnection(reason);
  }, RECOVERY_DELAY_MS);
}

async function recoverConnection() {
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
  } else {
    await addLocalTracks();
  }
  await flushCandidateQueue();
  setSessionState(SESSION_STATE.CONNECTING, "تمت إعادة إنشاء الاتصال...");
}

function endSession(message = "تم إنهاء الجلسة") {
  if (endSessionRequested) return;
  endSessionRequested = true;
  emitWithSession("end-session", {}, () => {});
  resetSession(message);
}

async function switchCamera() {
  if (!localStream) return;
  currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
  stopTracks(localStream);
  localStream = null;
  await createLocalStream();
  if (peerConnection) {
    const videoTrack = localStream.getVideoTracks()[0];
    for (const sender of peerConnection.getSenders()) {
      if (sender.track && sender.track.kind === "video" && videoTrack) {
        await sender.replaceTrack(videoTrack);
      }
    }
  }
}

async function createRoom() {
  if (isCreatingRoom) return;
  isCreatingRoom = true;
  setSessionState(SESSION_STATE.CREATING_ROOM, "جارٍ إنشاء الجلسة...");

  try {
    await createLocalStream();
    socket.emit("create-room", (result) => {
      isCreatingRoom = false;
      if (!result || !result.success) {
        setSessionState(SESSION_STATE.ERROR, (result && result.message) || "تعذّر إنشاء الجلسة");
        return;
      }

      roomId = result.roomId;
      sessionToken = result.sessionToken;
      isCreator = true;
      if (sessionCodeEl) sessionCodeEl.textContent = roomId;
      if (sessionArea) sessionArea.hidden = false;
      if (joinSection) joinSection.hidden = true;
      const inviteLink = showInviteLink(roomId);
      ensurePeerConnection().then(() => createOffer(false));
      setSessionState(SESSION_STATE.CONNECTING, "تم إنشاء الجلسة بنجاح، بانتظار الطرف الآخر...");
      copyInviteBtn && copyInviteBtn.addEventListener("click", () => copyInviteLinkToClipboard(inviteLink));
    });
  } catch (error) {
    isCreatingRoom = false;
    console.error("createRoom failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر تشغيل الكاميرا قبل إنشاء الجلسة");
  }
}

async function joinRoom() {
  if (isJoiningRoom) return;
  const targetRoomId = (joinInput && joinInput.value ? joinInput.value : inviteRoomId || "").trim().toUpperCase();
  if (!targetRoomId) {
    setStatus("أدخل كود الجلسة أولاً");
    return;
  }

  isJoiningRoom = true;
  setSessionState(SESSION_STATE.JOINING_ROOM, "جارٍ الانضمام للجلسة...");

  try {
    await createLocalStream();
    socket.emit("join-room", { roomId: targetRoomId, sessionToken: targetRoomId }, (result) => {
      isJoiningRoom = false;
      if (!result || !result.success) {
        setSessionState(SESSION_STATE.ERROR, (result && result.message) || "تعذّر الانضمام للجلسة");
        return;
      }

      roomId = result.roomId;
      sessionToken = result.sessionToken;
      isCreator = false;
      if (sessionCodeEl) sessionCodeEl.textContent = roomId;
      if (sessionArea) sessionArea.hidden = false;
      if (inviteArea) inviteArea.hidden = true;
      if (joinSection) joinSection.hidden = true;
      setSessionState(SESSION_STATE.CONNECTING, "تم الانضمام، بانتظار اتصال الطرف الآخر...");
      ensurePeerConnection();
    });
  } catch (error) {
    isJoiningRoom = false;
    console.error("joinRoom failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر تشغيل الكاميرا قبل الانضمام للجلسة");
  }
}

function leaveSession() {
  socket.emit("leave", {}, () => {});
  resetSession("تمت مغادرة الجلسة");
}

socket.on("offer", handleIncomingOffer);
socket.on("answer", handleIncomingAnswer);
socket.on("ice-candidate", handleIncomingCandidate);
socket.on("user-joined", (payload) => {
  if (payload && payload.roomId === roomId) {
    hasRemotePeer = true;
    if (isCreator) createOffer(false);
  }
});
socket.on("peer-left", (payload) => {
  if (payload && payload.roomId === roomId) {
    hasRemotePeer = false;
    setSessionState(SESSION_STATE.CONNECTING, "غادر الطرف الآخر الجلسة");
  }
});
socket.on("room-ended", (payload) => {
  if (!payload || payload.roomId !== roomId) return;
  endSessionRequested = true;
  resetSession("انتهت الجلسة");
});
socket.on("connect", () => {
  if (roomId && sessionToken && state === SESSION_STATE.RECOVERING) {
    setStatus("تمت استعادة الاتصال بالخادم");
  }
});
socket.on("disconnect", () => {
  if (!endSessionRequested) scheduleRecovery("socket-disconnect");
});

if (cameraBtn) cameraBtn.addEventListener("click", createLocalStream);
if (switchCameraBtn) switchCameraBtn.addEventListener("click", switchCamera);
if (createRoomBtn) createRoomBtn.addEventListener("click", createRoom);
if (joinBtn) joinBtn.addEventListener("click", joinRoom);
if (endRoomBtn) endRoomBtn.addEventListener("click", endSession);

if (inviteRoomId && joinInput) {
  joinInput.value = inviteRoomId.toUpperCase();
  setStatus("تم فتح رابط الدعوة، اضغط انضمام");
}

window.addEventListener("beforeunload", () => {
  if (!endSessionRequested) socket.emit("leave", {}, () => {});
});
