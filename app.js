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
const shareInviteBtn = document.getElementById("shareInviteBtn");

const TURN_URL = (window.__TURN_URL__ || "").trim();
const TURN_USERNAME = (window.__TURN_USERNAME__ || "").trim();
const TURN_PASSWORD = (window.__TURN_PASSWORD__ || "").trim();
const invitedRoomId = new URLSearchParams(window.location.search).get("room");

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

const ICE_FLUSH_TIMEOUT_MS = 5000;

let state = SESSION_STATE.IDLE;
let localStream = null;
let pc = null;
let roomId = null;
let sessionToken = null;
let isCreator = false;
let currentFacingMode = "user";
let isCreatingRoom = false;
let isJoiningRoom = false;
let endSessionRequested = false;
let rtcConfig = null;
let candidateQueue = [];
let seenCandidateKeys = new Set();
let localControlsInitialized = false;
let roomEndedByRemote = false;

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function setSessionState(nextState, message) {
  state = nextState;
  if (message) setStatus(message);
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

function safeAck(callback, payload) {
  if (typeof callback === "function") callback(payload);
}

function getRtcConfig() {
  if (rtcConfig) return rtcConfig;
  const iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (TURN_URL && TURN_USERNAME && TURN_PASSWORD) {
    iceServers.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_PASSWORD });
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
  candidateQueue.push(candidate);
}

async function flushCandidateQueue() {
  if (!pc || !pc.remoteDescription) return;
  while (candidateQueue.length > 0) {
    const candidate = candidateQueue.shift();
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.error("Failed to add queued ICE candidate", error);
    }
  }
}

function clearCandidateQueue() {
  candidateQueue = [];
  seenCandidateKeys = new Set();
}

function resetSessionReferences() {
  roomId = null;
  sessionToken = null;
  isCreator = false;
  endSessionRequested = false;
  isCreatingRoom = false;
  isJoiningRoom = false;
  roomEndedByRemote = false;
}

function cleanupPeerConnection() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.onsignalingstatechange = null;
    try {
      pc.close();
    } catch (error) {
      console.error("Failed to close RTCPeerConnection", error);
    }
  }
  pc = null;
  clearCandidateQueue();
}

function clearInviteUI() {
  if (sessionCodeEl) sessionCodeEl.textContent = "--------";
  if (inviteArea) inviteArea.hidden = true;
  if (inviteLinkEl) {
    inviteLinkEl.textContent = "";
    inviteLinkEl.href = "#";
  }
  if (sessionArea) sessionArea.hidden = true;
  if (joinSection) joinSection.hidden = false;
}

function resetToInitialState(message = "جاهز للعمل") {
  cleanupPeerConnection();
  stopTracks(localStream);
  localStream = null;
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  clearInviteUI();
  resetSessionReferences();
  setSessionState(SESSION_STATE.IDLE, message);
}

function setInviteLink(room) {
  const link = `${window.location.origin}/?room=${encodeURIComponent(room)}`;
  if (inviteLinkEl) {
    inviteLinkEl.href = link;
    inviteLinkEl.textContent = link;
    inviteLinkEl.target = "_blank";
    inviteLinkEl.rel = "noopener noreferrer";
  }
  if (inviteArea) inviteArea.hidden = false;
  return link;
}

async function copyInviteLink(link) {
  if (!link) return false;
  try {
    await navigator.clipboard.writeText(link);
    setStatus("تم نسخ رابط الدعوة ✅");
    return true;
  } catch (error) {
    console.error("copy failed", error);
    setStatus("تعذّر نسخ الرابط");
    return false;
  }
}

function shareInviteLink(link) {
  if (!link) return;
  if (navigator.share) {
    navigator.share({ title: "شاهد معي", text: "رابط الجلسة", url: link }).catch((error) => {
      console.error("share failed", error);
    });
    return;
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(link)}`, "_blank", "noopener,noreferrer");
}

async function createLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });
  if (localVideo) localVideo.srcObject = localStream;
  setSessionState(SESSION_STATE.LOCAL_READY, "تم تشغيل الكاميرا ✅");
  return localStream;
}

function createPeerConnection() {
  const connection = new RTCPeerConnection(getRtcConfig());

  connection.ontrack = (event) => {
    const stream = event.streams && event.streams[0];
    if (stream && remoteVideo) remoteVideo.srcObject = stream;
  };

  connection.onicecandidate = (event) => {
    if (!event.candidate || !roomId || !sessionToken || endSessionRequested) return;
    emitWithSession("ice-candidate", { candidate: event.candidate });
  };

  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "connected") {
      setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بنجاح ✅");
      return;
    }
    if (connection.connectionState === "connecting") {
      setSessionState(SESSION_STATE.CONNECTING, "جارٍ الاتصال...");
      return;
    }
    if (["failed", "disconnected"].includes(connection.connectionState)) {
      setStatus("فقد الاتصال مؤقتًا");
    }
  };

  connection.oniceconnectionstatechange = () => {
    if (connection.iceConnectionState === "failed") {
      setStatus("فشل ICE");
    }
  };

  return connection;
}

async function ensurePeerConnection() {
  if (!pc) {
    pc = createPeerConnection();
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }
  }
  return pc;
}

async function createOffer() {
  if (!isCreator || !pc || !roomId || endSessionRequested) return;
  if (pc.signalingState === "have-local-offer") return;

  try {
    await ensurePeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    emitWithSession("offer", { offer });
    setSessionState(SESSION_STATE.CONNECTING, "تم إرسال عرض الاتصال...");
  } catch (error) {
    console.error("createOffer failed", error);
    setStatus("تعذّر إنشاء العرض");
  }
}

async function createAnswer() {
  if (!pc || endSessionRequested) return;
  try {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    emitWithSession("answer", { answer });
    await flushCandidateQueue();
    setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بالطرف الآخر ✅");
  } catch (error) {
    console.error("createAnswer failed", error);
    setStatus("تعذّر إنشاء الإجابة");
  }
}

async function handleIncomingOffer(payload) {
  if (!payload || !payload.offer || endSessionRequested) return;
  await ensurePeerConnection();
  try {
    await pc.setRemoteDescription(payload.offer);
    await createAnswer();
  } catch (error) {
    console.error("handleIncomingOffer failed", error);
    setStatus("تعذّر استقبال العرض");
  }
}

async function handleIncomingAnswer(payload) {
  if (!payload || !payload.answer || !pc || endSessionRequested) return;
  try {
    await pc.setRemoteDescription(payload.answer);
    await flushCandidateQueue();
    setSessionState(SESSION_STATE.CONNECTED, "تم الاتصال بالطرف الآخر ✅");
  } catch (error) {
    console.error("handleIncomingAnswer failed", error);
    setStatus("تعذّر استقبال الإجابة");
  }
}

async function handleIncomingCandidate(payload) {
  if (!payload || !payload.candidate || endSessionRequested) return;
  try {
    if (!pc || !pc.remoteDescription) {
      enqueueCandidate(payload.candidate);
      return;
    }
    await pc.addIceCandidate(payload.candidate);
  } catch (error) {
    console.error("Failed to handle ICE candidate", error);
  }
}

async function cleanupSession({ notifyRemote = false } = {}) {
  endSessionRequested = true;
  if (notifyRemote) {
    emitWithSession("end-session", {}, () => {});
  }
  try {
    socket.disconnect();
  } catch (error) {
    console.error(error);
  }
  cleanupPeerConnection();
  stopTracks(localStream);
  localStream = null;
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  if (inviteArea) inviteArea.hidden = true;
  if (inviteLinkEl) {
    inviteLinkEl.textContent = "";
    inviteLinkEl.href = "#";
  }
  if (sessionCodeEl) sessionCodeEl.textContent = "--------";
  if (sessionArea) sessionArea.hidden = true;
  if (joinSection) joinSection.hidden = false;
  roomId = null;
  sessionToken = null;
  isCreator = false;
  isCreatingRoom = false;
  isJoiningRoom = false;
  roomEndedByRemote = false;
  setSessionState(SESSION_STATE.IDLE, "تم إنهاء الجلسة");
}

async function switchCamera() {
  if (!localStream) return;
  currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
  stopTracks(localStream);
  localStream = null;
  await createLocalStream();
  if (pc) {
    const videoTrack = localStream.getVideoTracks()[0];
    for (const sender of pc.getSenders()) {
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
    socket.emit("create-room", async (result) => {
      isCreatingRoom = false;
      if (!result || !result.success) {
        setSessionState(SESSION_STATE.ERROR, (result && result.message) || "تعذّر إنشاء الجلسة");
        return;
      }
      roomId = result.roomId;
      sessionToken = result.sessionToken;
      isCreator = true;
      if (sessionCodeEl) sessionCodeEl.textContent = roomId;
      const inviteLink = setInviteLink(roomId);
      if (sessionArea) sessionArea.hidden = false;
      if (joinSection) joinSection.hidden = true;
      await ensurePeerConnection();
      await createOffer();
      copyInviteLink(inviteLink);
    });
  } catch (error) {
    isCreatingRoom = false;
    console.error("createRoom failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر إنشاء الجلسة");
  }
}

async function joinRoom(targetRoomId) {
  if (isJoiningRoom) return;
  isJoiningRoom = true;
  setSessionState(SESSION_STATE.JOINING_ROOM, "جارٍ الانضمام للجلسة...");

  try {
    await createLocalStream();
    socket.emit("join-room", { roomId: targetRoomId }, async (result) => {
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
      if (joinSection) joinSection.hidden = true;
      setInviteLink(roomId);
      await ensurePeerConnection();
      setSessionState(SESSION_STATE.CONNECTING, `تم الانضمام إلى الجلسة: ${roomId}`);
    });
  } catch (error) {
    isJoiningRoom = false;
    console.error("joinRoom failed", error);
    setSessionState(SESSION_STATE.ERROR, "تعذّر الانضمام للجلسة");
  }
}

function wireControlsOnce() {
  if (localControlsInitialized) return;
  localControlsInitialized = true;

  if (cameraBtn) cameraBtn.onclick = async () => {
    try {
      await createLocalStream();
    } catch (error) {
      console.error(error);
      setStatus("تعذّر تشغيل الكاميرا");
    }
  };

  if (switchCameraBtn) switchCameraBtn.onclick = async () => {
    try {
      await switchCamera();
    } catch (error) {
      console.error(error);
      setStatus("تعذّر تبديل الكاميرا");
    }
  };

  if (createRoomBtn) createRoomBtn.onclick = () => createRoom();
  if (joinBtn) joinBtn.onclick = () => joinRoom((joinInput && joinInput.value || "").trim().replace(/^.*[?&]room=([^&]+).*$/i, "$1"));
  if (endRoomBtn) endRoomBtn.onclick = () => cleanupSession({ notifyRemote: true });

  if (copyInviteBtn) copyInviteBtn.onclick = () => {
    if (inviteLinkEl && inviteLinkEl.href && inviteLinkEl.href !== "#") copyInviteLink(inviteLinkEl.href);
  };

  if (shareInviteBtn) shareInviteBtn.onclick = () => {
    if (inviteLinkEl && inviteLinkEl.href && inviteLinkEl.href !== "#") shareInviteLink(inviteLinkEl.href);
  };

  if (remoteVideo) remoteVideo.onclick = () => {
    document.body.classList.toggle("fullscreen-mode");
  };

  if (inviteLinkEl) inviteLinkEl.onclick = (event) => {
    event.preventDefault();
    const link = inviteLinkEl.href;
    if (link && link !== "#") window.open(link, "_blank", "noopener,noreferrer");
  };
}

function bindJoinInputFromLink() {
  if (!joinInput) return;
  if (invitedRoomId) joinInput.value = invitedRoomId;
}

socket.on("offer", handleIncomingOffer);
socket.on("answer", handleIncomingAnswer);
socket.on("ice-candidate", handleIncomingCandidate);
socket.on("peer-left", () => setStatus("غادر الطرف الآخر الجلسة"));
socket.on("room-ended", async () => {
  roomEndedByRemote = true;
  await cleanupSession({ notifyRemote: false });
});
socket.on("connect_error", () => setStatus("تعذّر الاتصال بالخادم"));
socket.on("disconnect", () => {
  if (!endSessionRequested) setStatus("تم قطع الاتصال بالخادم");
});

window.addEventListener("beforeunload", () => {
  try {
    if (roomId && sessionToken) socket.emit("leave", { roomId, sessionToken });
  } catch (error) {
    console.error(error);
  }
});

wireControlsOnce();
bindJoinInputFromLink();
setStatus("جاهز للعمل");

if (invitedRoomId) {
  setStatus("تم العثور على رابط دعوة، أدخل إلى الجلسة من الزر");
}
