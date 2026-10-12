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
let roomRole = null;
let localTracksAdded = false;
let offerInFlight = false;
let answerInFlight = false;
let reconnecting = false;

function log(tag, details = "") {
  console.log(`[WebRTC] ${tag}`, details);
}

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function resetButtons() {
  if (cameraBtn) cameraBtn.disabled = false;
  if (switchCameraBtn) switchCameraBtn.disabled = !localStream;
  if (createRoomBtn) createRoomBtn.disabled = false;
  if (joinBtn) joinBtn.disabled = false;
  if (endRoomBtn) endRoomBtn.disabled = !localStream;
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

function getRtcConfig() {
  const iceServers = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302"
      ]
    }
  ];

  if (TURN_URL && TURN_USERNAME && TURN_PASSWORD) {
    iceServers.push({
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_PASSWORD
    });
  }

  return { iceServers, iceCandidatePoolSize: 0 };
}

function emitWithSession(event, payload = {}, callback) {
  if (!roomId || !sessionToken || sessionEnded) {
    if (typeof callback === "function") {
      callback({ success: false, message: "no active session" });
    }
    return false;
  }

  socket.emit(event, {
    ...payload,
    roomId,
    sessionToken
  }, callback);

  return true;
}

function candidateKey(candidate) {
  if (!candidate) return "";
  return [
    candidate.candidate || "",
    candidate.sdpMid || "",
    candidate.sdpMLineIndex ?? ""
  ].join("|");
}

function queueCandidate(candidate) {
  const key = candidateKey(candidate);
  if (!key) return;

  if (!candidateQueue.some((item) => candidateKey(item) === key)) {
    candidateQueue.push(candidate);
  }
}

async function flushCandidateQueue() {
  if (!peerConnection || !peerConnection.remoteDescription) return;

  const queued = candidateQueue;
  candidateQueue = [];

  for (const candidate of queued) {
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error("[WebRTC] queued ICE candidate failed", error);
    }
  }
}

async function ensureLocalStream() {
  if (localStream) return localStream;

  localStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });

  localVideo.srcObject = localStream;
  switchCameraBtn.disabled = false;
  endRoomBtn.disabled = false;
  setStatus("تم تشغيل الكاميرا ✅");

  return localStream;
}

function addLocalTracksOnce() {
  if (!peerConnection || !localStream || localTracksAdded) return;

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  localTracksAdded = true;
  log("LOCAL_TRACKS_ADDED");
}

function ensurePeerConnection() {
  if (peerConnection) return peerConnection;

  peerConnection = new RTCPeerConnection(getRtcConfig());
  log("PC_CREATED");

  peerConnection.ontrack = (event) => {
    const stream = event.streams?.[0];
    if (!stream) return;

    if (remoteVideo.srcObject !== stream) {
      remoteVideo.srcObject = stream;
      setStatus("تم الاتصال بالطرف الآخر ✅");
      log("REMOTE_STREAM_ATTACHED");
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) return;

    emitWithSession("ice-candidate", {
      candidate: event.candidate
    });

    log("ICE_SENT");
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    log("CONNECTION_STATE", state);

    if (state === "connected") {
      setStatus("الاتصال يعمل الآن ✅");
    } else if (state === "connecting") {
      setStatus("جاري الاتصال بالطرف الآخر…");
    } else if (state === "disconnected") {
      setStatus("انقطع الاتصال مؤقتًا…");
    } else if (state === "failed") {
      setStatus("فشل اتصال WebRTC");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    log("ICE_STATE", peerConnection?.iceConnectionState);
  };

  return peerConnection;
}

async function createOffer() {
  if (
    roomRole !== "creator" ||
    sessionEnded ||
    !peerConnection ||
    offerInFlight ||
    peerConnection.signalingState !== "stable"
  ) {
    return;
  }

  offerInFlight = true;

  try {
    log("CREATE_OFFER");
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    emitWithSession("offer", {
      offer: peerConnection.localDescription
    });

    log("OFFER_SENT");
  } catch (error) {
    console.error("[WebRTC] createOffer failed", error);
  } finally {
    offerInFlight = false;
  }
}

async function handleOffer(payload) {
  if (!payload?.offer || sessionEnded) return;

  const pc = ensurePeerConnection();
  addLocalTracksOnce();

  if (pc.signalingState !== "stable") {
    log("OFFER_IGNORED", pc.signalingState);
    return;
  }

  try {
    log("OFFER_RECEIVED");
    await pc.setRemoteDescription(payload.offer);
    await flushCandidateQueue();

    answerInFlight = true;
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    emitWithSession("answer", {
      answer: pc.localDescription
    });

    log("ANSWER_SENT");
  } catch (error) {
    console.error("[WebRTC] handleOffer failed", error);
  } finally {
    answerInFlight = false;
  }
}

async function handleAnswer(payload) {
  if (!payload?.answer || sessionEnded || !peerConnection) return;

  const pc = peerConnection;

  if (pc.signalingState !== "have-local-offer") {
    log("ANSWER_IGNORED", pc.signalingState);
    return;
  }

  try {
    log("ANSWER_RECEIVED");
    await pc.setRemoteDescription(payload.answer);
    await flushCandidateQueue();
    setStatus("تم تأسيس الاتصال ✅");
  } catch (error) {
    console.error("[WebRTC] handleAnswer failed", error);
  }
}

async function handleCandidate(payload) {
  if (!payload?.candidate || sessionEnded) return;

  if (!peerConnection || !peerConnection.remoteDescription) {
    queueCandidate(payload.candidate);
    return;
  }

  try {
    await peerConnection.addIceCandidate(payload.candidate);
    log("ICE_RECEIVED");
  } catch (error) {
    console.error("[WebRTC] addIceCandidate failed", error);
  }
}

function resetSignalingState() {
  candidateQueue = [];
  localTracksAdded = false;
  offerInFlight = false;
  answerInFlight = false;
}

async function cleanupLocalSession() {
  sessionEnded = true;
  reconnecting = false;
  roomId = null;
  sessionToken = null;
  roomRole = null;
  resetSignalingState();

  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  stopTracks(localStream);
  localStream = null;

  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;

  hideInviteCard();
  setInitialUi();
  setStatus("جاهز للعمل");
  log("SESSION_CLEANED");
}

function hideInviteCard() {
  if (inviteArea) inviteArea.hidden = true;
  if (inviteLinkEl) {
    inviteLinkEl.textContent = "";
    inviteLinkEl.href = "#";
  }
}

async function endSession() {
  if (sessionEnded) return;

  const activeRoomId = roomId;
  const activeToken = sessionToken;
  sessionEnded = true;

  if (activeRoomId && activeToken) {
    socket.emit("end-session", {
      roomId: activeRoomId,
      sessionToken: activeToken
    });
  }

  await cleanupLocalSession();

  if (!socket.connected) {
    socket.connect();
  }
}

async function switchCamera() {
  if (!localStream || sessionEnded) return;

  currentFacingMode =
    currentFacingMode === "user" ? "environment" : "user";

  const nextStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: currentFacingMode },
    audio: true
  });

  const nextVideoTrack = nextStream.getVideoTracks()[0];
  const oldStream = localStream;

  localStream = nextStream;
  localVideo.srcObject = nextStream;

  if (peerConnection && nextVideoTrack) {
    const sender = peerConnection
      .getSenders()
      .find((item) => item.track?.kind === "video");

    if (sender) {
      await sender.replaceTrack(nextVideoTrack);
    }
  }

  stopTracks(oldStream);
  setStatus("تم تبديل الكاميرا ✅");
}

function showInvite(room) {
  inviteLink = `${window.location.origin}/?room=${encodeURIComponent(room)}`;

  sessionArea.hidden = false;
  joinSection.hidden = true;
  inviteArea.hidden = false;

  sessionCodeEl.textContent = room;
  inviteLinkEl.textContent = inviteLink;
  inviteLinkEl.href = inviteLink;

  copyInviteBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setStatus("تم نسخ رابط الدعوة ✅");
    } catch {
      setStatus("تعذّر نسخ الرابط");
    }
  };

  shareInviteBtn.onclick = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: "شاهد معي",
          text: "انضم إلى جلسة شاهد معي",
          url: inviteLink
        });
      } else {
        window.open(
          `https://wa.me/?text=${encodeURIComponent(inviteLink)}`,
          "_blank",
          "noopener,noreferrer"
        );
      }
    } catch {
      // User cancelled native share; keep the session alive.
    }
  };
}

async function createRoom() {
  if (roomId || sessionEnded === false && roomRole) return;

  sessionEnded = false;
  roomRole = "creator";

  try {
    await ensureLocalStream();

    socket.emit("create-room", async (result) => {
      if (!result?.success) {
        roomRole = null;
        setStatus(result?.message || "تعذّر إنشاء الجلسة");
        return;
      }

      roomId = result.roomId;
      sessionToken = result.sessionToken;

      ensurePeerConnection();
      addLocalTracksOnce();
      showInvite(roomId);

      setStatus("تم إنشاء الجلسة. أرسل الرابط وانتظر انضمام الطرف الآخر.");
      log("ROOM_CREATED", roomId);

      // IMPORTANT: no offer here.
      // The server emits user-joined only after the second peer joins.
    });
  } catch (error) {
    console.error("[WebRTC] createRoom failed", error);
    roomRole = null;
    setStatus("تعذّر إنشاء الجلسة");
  }
}

async function joinRoom(targetRoomId) {
  if (roomId) return;

  sessionEnded = false;
  roomRole = "guest";

  try {
    await ensureLocalStream();

    socket.emit("join-room", { roomId: targetRoomId }, async (result) => {
      if (!result?.success) {
        roomRole = null;
        setStatus(result?.message || "تعذّر الانضمام للجلسة");
        return;
      }

      roomId = result.roomId;
      sessionToken = result.sessionToken;

      ensurePeerConnection();
      addLocalTracksOnce();

      sessionArea.hidden = false;
      joinSection.hidden = true;
      sessionCodeEl.textContent = roomId;

      setStatus("تم الانضمام. في انتظار اتصال الطرف الآخر…");
      log("ROOM_JOINED", roomId);

      // Guest never creates the initial offer.
      // The creator creates exactly one offer after user-joined.
    });
  } catch (error) {
    console.error("[WebRTC] joinRoom failed", error);
    roomRole = null;
    setStatus("تعذّر الانضمام للجلسة");
  }
}

socket.on("user-joined", async () => {
  if (sessionEnded || roomRole !== "creator") return;

  log("PEER_JOINED");
  ensurePeerConnection();
  addLocalTracksOnce();

  // This is the only initial offer trigger.
  await createOffer();
});

socket.on("offer", handleOffer);
socket.on("answer", handleAnswer);
socket.on("ice-candidate", handleCandidate);

socket.on("room-ended", async () => {
  setStatus("أنهى منشئ الجلسة الاتصال");
  await cleanupLocalSession();
});

socket.on("peer-left", async () => {
  setStatus("غادر الطرف الآخر الجلسة");
  await cleanupLocalSession();
});

socket.on("connect", async () => {
  log("SOCKET_CONNECTED", socket.id);

  if (reconnecting && roomId && sessionToken) {
    setStatus("عاد اتصال الخادم، جاري استعادة الجلسة…");
    // The current server binds the session to a socket ID.
    // Do not create another PeerConnection or another offer here.
    reconnecting = false;
  } else if (!roomId) {
    setStatus("متصل بالخادم");
  }
});

socket.on("disconnect", () => {
  if (!sessionEnded && roomId) {
    reconnecting = true;
    setStatus("انقطع اتصال الخادم، جارٍ إعادة الاتصال…");
  }
});

socket.on("connect_error", (error) => {
  console.error("[Socket.io] connect_error", error);
  if (!sessionEnded) setStatus("تعذّر الاتصال بالخادم");
});

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
    setStatus("تعذّر تبديل الكاميرا");
  }
});

createRoomBtn?.addEventListener("click", createRoom);

joinBtn?.addEventListener("click", async () => {
  const code = (joinInput?.value || invitedRoomId || "").trim().toUpperCase();

  if (!code) {
    setStatus("أدخل رمز الجلسة");
    return;
  }

  await joinRoom(code);
});

endRoomBtn?.addEventListener("click", endSession);

setInitialUi();

if (invitedRoomId && joinInput) {
  joinInput.value = invitedRoomId.toUpperCase();
}
