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

let localStream = null;
let peerConnection = null;
let roomId = null;
let sessionToken = null;
let candidateQueue = [];
let currentFacingMode = "user";
let sessionEnded = false;
let inviteLink = "";
let roomJoined = false;
let roomCreated = false;
let localTracksAdded = false;
let offerCreated = false;
let answerCreated = false;
let cleanupGeneration = 0;
let currentJoinPromise = null;
let currentCreatePromise = null;

function log(tag) {
  console.log(tag);
}

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

function resetButtons() {
  if (cameraBtn) cameraBtn.disabled = false;
  if (switchCameraBtn) switchCameraBtn.disabled = true;
  if (createRoomBtn) createRoomBtn.disabled = false;
  if (joinBtn) joinBtn.disabled = false;
  if (endRoomBtn) endRoomBtn.disabled = true;
}

function setInitialUi() {
  if (sessionCodeEl) sessionCodeEl.textContent = "--------";
  if (inviteArea) inviteArea.hidden = true;
  if (inviteLinkEl) {
    inviteLinkEl.textContent = "";
    inviteLinkEl.href = "#";
  }
  if (sessionArea) sessionArea.hidden = true;
  if (joinSection) joinSection.hidden = false;
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  resetButtons();
}

function hideInviteCard() {
  if (inviteArea) inviteArea.hidden = true;
  if (inviteLinkEl) {
    inviteLinkEl.textContent = "";
    inviteLinkEl.href = "#";
  }
}

function getRtcConfig() {
  const iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (TURN_URL && TURN_USERNAME && TURN_PASSWORD) {
    iceServers.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_PASSWORD });
  }
  return { iceServers, iceCandidatePoolSize: 0 };
}

function emitWithSession(event, payload = {}, callback) {
  if (!roomId || !sessionToken || sessionEnded) {
    if (typeof callback === "function") callback({ success: false, message: "no active session" });
    return false;
  }
  socket.emit(event, { ...payload, roomId, sessionToken }, callback);
  return true;
}

function candidateKey(candidate) {
  return [candidate?.candidate || "", candidate?.sdpMid || "", candidate?.sdpMLineIndex ?? ""].join("|");
}

function queueCandidate(candidate) {
  const key = candidateKey(candidate);
  if (!candidate || !key) return;
  if (candidateQueue.some((item) => candidateKey(item) === key)) return;
  candidateQueue.push(candidate);
}

async function flushCandidateQueue() {
  if (!peerConnection || !peerConnection.remoteDescription || sessionEnded) return;
  const queue = candidateQueue;
  candidateQueue = [];
  for (const candidate of queue) {
    try {
      await peerConnection.addIceCandidate(candidate);
      log("ICE_RECEIVED");
    } catch (error) {
      console.error(error);
    }
  }
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });
  if (localVideo) localVideo.srcObject = localStream;
  if (switchCameraBtn) switchCameraBtn.disabled = false;
  if (endRoomBtn) endRoomBtn.disabled = false;
  setStatus("تم تشغيل الكاميرا ✅");
  return localStream;
}

function addLocalTracksOnce() {
  if (!peerConnection || !localStream || localTracksAdded) return;
  for (const track of localStream.getTracks()) {
    peerConnection.addTrack(track, localStream);
  }
  localTracksAdded = true;
}

function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  log("CREATE_PC");
  peerConnection = new RTCPeerConnection(getRtcConfig());
  peerConnection.ontrack = (event) => {
    const stream = event.streams && event.streams[0];
    if (!stream) return;
    if (!remoteVideo.srcObject) {
      remoteVideo.srcObject = stream;
      log("ONTRACK");
    }
  };
  peerConnection.onicecandidate = (event) => {
    if (!event.candidate || sessionEnded || !roomId || !sessionToken) return;
    log("ICE_SENT");
    emitWithSession("ice-candidate", { candidate: event.candidate });
  };
  return peerConnection;
}

async function createOfferOnce() {
  if (!peerConnection || sessionEnded || offerCreated) return;
  if (!roomJoined) throw new Error("offer before user-joined");
  offerCreated = true;
  log("CREATE_OFFER");
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  emitWithSession("offer", { offer });
}

async function createAnswerOnce() {
  if (!peerConnection || sessionEnded || answerCreated) return;
  answerCreated = true;
  log("CREATE_ANSWER");
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  emitWithSession("answer", { answer });
}

async function handleOffer(payload) {
  if (!payload?.offer || sessionEnded) return;
  log("OFFER_RECEIVED");
  ensurePeerConnection();
  if (peerConnection.signalingState !== "stable" && peerConnection.signalingState !== "have-local-offer") return;
  await peerConnection.setRemoteDescription(payload.offer);
  log("SET_REMOTE_DESCRIPTION");
  await flushCandidateQueue();
  await createAnswerOnce();
}

async function handleAnswer(payload) {
  if (!payload?.answer || sessionEnded) return;
  log("ANSWER_RECEIVED");
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(payload.answer);
  log("SET_REMOTE_DESCRIPTION");
  await flushCandidateQueue();
}

async function handleCandidate(payload) {
  if (!payload?.candidate || sessionEnded) return;
  if (!peerConnection) return;
  log("ICE_RECEIVED");
  if (!peerConnection.remoteDescription) {
    queueCandidate(payload.candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(payload.candidate);
  } catch (error) {
    console.error(error);
  }
}

async function cleanup() {
  cleanupGeneration += 1;
  sessionEnded = true;
  roomJoined = false;
  roomCreated = false;
  localTracksAdded = false;
  offerCreated = false;
  answerCreated = false;
  candidateQueue = [];

  try {
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.close();
    }
  } catch (error) {
    console.error(error);
  }
  peerConnection = null;

  stopTracks(localStream);
  localStream = null;

  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;

  roomId = null;
  sessionToken = null;
  hideInviteCard();
  setInitialUi();
  log("CLEANUP_DONE");
}

async function endSession(notifyRemote = true) {
  if (sessionEnded) return;
  sessionEnded = true;
  if (notifyRemote) {
    emitWithSession("end-session", {}, () => {});
  }
  try {
    socket.disconnect();
  } catch (error) {
    console.error(error);
  }
  await cleanup();
}

async function switchCamera() {
  if (!localStream || sessionEnded) return;
  currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
  const nextStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });
  const nextVideoTrack = nextStream.getVideoTracks()[0] || null;
  const oldStream = localStream;
  localStream = nextStream;
  if (localVideo) localVideo.srcObject = localStream;
  if (peerConnection) {
    for (const sender of peerConnection.getSenders()) {
      if (sender.track && sender.track.kind === "video" && nextVideoTrack) {
        await sender.replaceTrack(nextVideoTrack);
      }
    }
  }
  stopTracks(oldStream);
}

async function createRoom() {
  if (currentCreatePromise) return currentCreatePromise;
  currentCreatePromise = (async () => {
    sessionEnded = false;
    await ensureLocalStream();
    socket.emit("create-room", async (result) => {
      if (!result?.success) {
        setStatus(result?.message || "تعذّر إنشاء الجلسة");
        currentCreatePromise = null;
        return;
      }
      roomCreated = true;
      roomJoined = false;
      roomId = result.roomId;
      sessionToken = result.sessionToken;
      if (sessionCodeEl) sessionCodeEl.textContent = roomId;
      if (sessionArea) sessionArea.hidden = false;
      if (joinSection) joinSection.hidden = true;
      inviteLink = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
      if (inviteArea) inviteArea.hidden = false;
      if (inviteLinkEl) {
        inviteLinkEl.textContent = inviteLink;
        inviteLinkEl.href = inviteLink;
        inviteLinkEl.target = "_blank";
        inviteLinkEl.rel = "noopener noreferrer";
      }
      ensurePeerConnection();
      addLocalTracksOnce();
      log("USER_JOINED");
      await createOfferOnce();
      if (copyInviteBtn) copyInviteBtn.onclick = () => navigator.clipboard.writeText(inviteLink).catch(() => {});
      if (shareInviteBtn) {
        shareInviteBtn.onclick = () => {
          if (navigator.share) {
            navigator.share({ title: "شاهد معي", url: inviteLink }).catch(() => {});
          } else {
            window.open(`https://wa.me/?text=${encodeURIComponent(inviteLink)}`, "_blank", "noopener,noreferrer");
          }
        };
      }
      currentCreatePromise = null;
    });
  })();
  return currentCreatePromise;
}

async function joinRoom(targetRoomId) {
  if (currentJoinPromise) return currentJoinPromise;
  currentJoinPromise = (async () => {
    sessionEnded = false;
    await ensureLocalStream();
    socket.emit("join-room", { roomId: targetRoomId }, async (result) => {
      if (!result?.success) {
        setStatus(result?.message || "تعذّر الانضمام للجلسة");
        currentJoinPromise = null;
        return;
      }
      roomJoined = true;
      roomCreated = false;
      roomId = result.roomId;
      sessionToken = result.sessionToken;
      if (sessionCodeEl) sessionCodeEl.textContent = roomId;
      if (sessionArea) sessionArea.hidden = false;
      if (joinSection) joinSection.hidden = true;
      ensurePeerConnection();
      addLocalTracksOnce();
      log("USER_JOINED");
      currentJoinPromise = null;
    });
  })();
  return currentJoinPromise;
}

async function handleEndSessionFromRemote() {
  log("ROOM_ENDED");
  await cleanup();
}

cameraBtn?.addEventListener("click", async () => {
  try {
    await ensureLocalStream();
  } catch (error) {
    console.error(error);
    setStatus("تعذّر تشغيل الكاميرا");
  }
});

switchCameraBtn?.addEventListener("click", async () => {
  try {
    await switchCamera();
  } catch (error) {
    console.error(error);
  }
});

createRoomBtn?.addEventListener("click", async () => {
  try {
    await createRoom();
  } catch (error) {
    console.error(error);
    setStatus("تعذّر إنشاء الجلسة");
  }
});

joinBtn?.addEventListener("click", async () => {
  const code = (joinInput?.value || invitedRoomId || "").trim().toUpperCase();
  if (!code) return setStatus("أدخل رمز الجلسة");
  try {
    await joinRoom(code);
  } catch (error) {
    console.error(error);
    setStatus("تعذّر الانضمام للجلسة");
  }
});

endRoomBtn?.addEventListener("click", async () => {
  try {
    await endSession(true);
  } catch (error) {
    console.error(error);
  }
});

socket.on("user-joined", async () => {
  if (sessionEnded) return;
  log("USER_JOINED");
  ensurePeerConnection();
  addLocalTracksOnce();
  await createOfferOnce();
});

socket.on("offer", handleOffer);
socket.on("answer", handleAnswer);
socket.on("ice-candidate", handleCandidate);
socket.on("room-ended", async () => {
  await handleEndSessionFromRemote();
});
socket.on("peer-left", async () => {
  log("ROOM_ENDED");
  await cleanup();
});
socket.on("connect", () => {
  if (sessionEnded) return;
  setStatus("متصل بالخادم");
});
socket.on("disconnect", () => {
  if (!sessionEnded) setStatus("انقطع الاتصال بالخادم");
});

setInitialUi();
if (invitedRoomId && joinInput) joinInput.value = invitedRoomId.toUpperCase();
