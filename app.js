const socket = io({
  path: "/socket.io",
  transports: ["polling", "websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000,
  upgrade: true,
  autoConnect: true
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
let serverIceServers = null;
let iceConfigPromise = null;

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
let iceRestartInFlight = false;
let iceRestartAttempts = 0;
let sessionReadyReceived = false;
let initialOfferSent = false;
let initialOfferTimer = null;
let joinResponseReceived = false;
let sessionBusy = false;
let cameraSwitchInFlight = false;
let cleanupInProgress = false;
let endSessionInFlight = false;
let roomOperationInFlight = false;
let signalingTransitionInFlight = false;

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

function withLock(lockName, fn) {
  if (sessionBusy) return false;
  sessionBusy = true;
  Promise.resolve()
    .then(fn)
    .catch((error) => console.error(`[WebRTC] ${lockName} failed`, error))
    .finally(() => {
      sessionBusy = false;
    });
  return true;
}

async function loadIceConfig() {
  if (serverIceServers) return serverIceServers;
  if (iceConfigPromise) return iceConfigPromise;

  iceConfigPromise = fetch("/ice-config", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("ICE config request failed");
      const config = await response.json();
      if (!Array.isArray(config.iceServers) || !config.iceServers.length) {
        throw new Error("ICE config is empty");
      }
      serverIceServers = config.iceServers;
      log("ICE_CONFIG_LOADED", { turnConfigured: Boolean(config.turnConfigured) });
      return serverIceServers;
    })
    .catch((error) => {
      console.error("[WebRTC] ICE config load failed; using STUN fallback", error);
      serverIceServers = [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
      ];
      return serverIceServers;
    });

  return iceConfigPromise;
}

function getRtcConfig() {
  const iceServers = serverIceServers || [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ];

  if (!serverIceServers && TURN_URL && TURN_USERNAME && TURN_PASSWORD) {
    iceServers.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_PASSWORD });
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
      iceRestartAttempts = 0;
      setStatus("الاتصال يعمل الآن ✅");
    } else if (state === "connecting") {
      setStatus("جاري الاتصال بالطرف الآخر…");
    } else if (state === "disconnected") {
      setStatus("انقطع الاتصال مؤقتًا…");
    } else if (state === "failed") {
      setStatus("فشل اتصال WebRTC؛ جارٍ محاولة استعادته…");
      requestIceRestart("connection-failed");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection?.iceConnectionState;
    log("ICE_STATE", state);
    if (state === "failed") requestIceRestart("ice-failed");
  };

  return peerConnection;
}

async function createOffer(iceRestart = false) {
  if (
    roomRole !== "creator" ||
    sessionEnded ||
    !peerConnection ||
    offerInFlight ||
    peerConnection.signalingState !== "stable" ||
    (!iceRestart && initialOfferSent)
  ) {
    return;
  }

  offerInFlight = true;

  try {
    log("CREATE_OFFER");
    const offer = await peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peerConnection.setLocalDescription(offer);

    emitWithSession("offer", {
      offer: peerConnection.localDescription
    });

    if (!iceRestart) {
      initialOfferSent = true;
    }

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

  if (pc.signalingState === "have-local-offer") {
    log("OFFER_COLLISION", pc.signalingState);
    return;
  }

  signalingTransitionInFlight = true;
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
    signalingTransitionInFlight = false;
  }
}

async function handleAnswer(payload) {
  if (!payload?.answer || sessionEnded || !peerConnection) return;

  const pc = peerConnection;

  if (pc.signalingState !== "have-local-offer") {
    log("ANSWER_IGNORED", pc.signalingState);
    return;
  }

  signalingTransitionInFlight = true;
  try {
    log("ANSWER_RECEIVED");
    await pc.setRemoteDescription(payload.answer);
    await flushCandidateQueue();
    setStatus("تم تأسيس الاتصال ✅");
  } catch (error) {
    console.error("[WebRTC] handleAnswer failed", error);
  } finally {
    signalingTransitionInFlight = false;
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
  iceRestartInFlight = false;
  iceRestartAttempts = 0;
  sessionReadyReceived = false;
  initialOfferSent = false;
  joinResponseReceived = false;
  signalingTransitionInFlight = false;
  if (initialOfferTimer) {
    clearTimeout(initialOfferTimer);
    initialOfferTimer = null;
  }
}

function requestIceRestart(reason) {
  if (roomRole !== "creator" || sessionEnded || iceRestartInFlight || iceRestartAttempts >= 2) {
    return;
  }

  iceRestartInFlight = true;
  setTimeout(async () => {
    try {
      if (
        sessionEnded || roomRole !== "creator" || !peerConnection ||
        peerConnection.signalingState !== "stable" || offerInFlight
      ) {
        return;
      }

      iceRestartAttempts += 1;
      log("ICE_RESTART_ATTEMPT", { reason, attempt: iceRestartAttempts });
      await createOffer(true);
    } catch (error) {
      console.error("[WebRTC] ICE restart failed", error);
    } finally {
      iceRestartInFlight = false;
    }
  }, 800);
}

async function cleanupLocalSession() {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  try {
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
  } finally {
    cleanupInProgress = false;
  }
}

function hideInviteCard() {
  if (inviteArea) inviteArea.hidden = true;
  if (inviteLinkEl) {
    inviteLinkEl.textContent = "";
    inviteLinkEl.href = "#";
  }
}

async function endSession() {
  if (endSessionInFlight || sessionEnded) return;
  endSessionInFlight = true;
  try {
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
  } finally {
    endSessionInFlight = false;
  }
}

async function switchCamera() {
  if (cameraSwitchInFlight || !localStream || sessionEnded) return;
  cameraSwitchInFlight = true;

  const oldVideoTrack = localStream.getVideoTracks()[0];
  if (!oldVideoTrack) {
    setStatus("لم يتم العثور على مسار الكاميرا الحالي");
    cameraSwitchInFlight = false;
    return;
  }

  const oldLocalStream = localStream;
  const previousVideoTrack = oldVideoTrack;
  const audioTracks = oldLocalStream.getAudioTracks().filter((track) => track.readyState === "live");
  const previousFacingMode = currentFacingMode;
  const currentSettings = previousVideoTrack.getSettings ? previousVideoTrack.getSettings() : {};
  const currentMode = currentSettings.facingMode || currentFacingMode;
  const desiredMode = currentMode === "environment" ? "user" : "environment";
  let nextStream = null;
  let nextVideoTrack = null;
  let sender = null;
  let replacedSuccessfully = false;

  const cameraConstraints = (mode, deviceId) => ({
    video: deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: mode } },
    audio: false
  });

  const requestFreshStream = async () => {
    try {
      return await navigator.mediaDevices.getUserMedia(cameraConstraints(desiredMode));
    } catch (firstError) {
      let lastError = firstError;

      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: desiredMode } },
          audio: false
        });
      } catch (secondError) {
        lastError = secondError;
      }

      if (typeof navigator.mediaDevices.enumerateDevices === "function") {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cameras = devices.filter((device) => device.kind === "videoinput");
          const currentDeviceId = currentSettings.deviceId || previousVideoTrack.getSettings?.().deviceId;
          const fallbackCamera = cameras.find((camera) => camera.deviceId !== currentDeviceId) || cameras[0];

          if (fallbackCamera) {
            return await navigator.mediaDevices.getUserMedia(cameraConstraints(desiredMode, fallbackCamera.deviceId));
          }
        } catch (deviceError) {
          lastError = deviceError;
        }
      }

      try {
        return await navigator.mediaDevices.getUserMedia({
          video: currentSettings.facingMode
            ? { facingMode: { ideal: currentSettings.facingMode } }
            : { facingMode: { ideal: currentFacingMode } },
          audio: false
        });
      } catch (restoreError) {
        lastError = restoreError;
      }

      throw lastError;
    }
  };

  try {
    log("SWITCH_START", {
      currentFacingMode,
      connectionState: peerConnection?.connectionState || null,
      iceConnectionState: peerConnection?.iceConnectionState || null
    });

    nextStream = await requestFreshStream();
    nextVideoTrack = nextStream?.getVideoTracks()[0] || null;

    if (!nextVideoTrack || nextVideoTrack.readyState !== "live") {
      throw new Error("new camera track unavailable");
    }

    sender = peerConnection
      ? peerConnection.getSenders().find((item) => item.track?.kind === "video")
      : null;

    if (sender) {
      await sender.replaceTrack(nextVideoTrack);
      replacedSuccessfully = true;
    } else {
      replacedSuccessfully = true;
    }

    const preservedAudioTracks = audioTracks.filter((track) => track.readyState === "live");
    const activeTracks = [nextVideoTrack, ...preservedAudioTracks];
    localStream = new MediaStream(activeTracks);
    currentFacingMode = desiredMode;

    if (localVideo) {
      localVideo.srcObject = localStream;
      if (typeof localVideo.play === "function") {
        await localVideo.play().catch(() => {});
      }
    }

    if (previousVideoTrack && previousVideoTrack !== nextVideoTrack && previousVideoTrack.readyState === "live") {
      previousVideoTrack.stop();
    }

    if (nextStream && nextStream !== localStream) {
      nextStream.getTracks().forEach((track) => {
        if (track !== nextVideoTrack && track.readyState === "live") {
          track.stop();
        }
      });
    }

    setStatus("تم تبديل الكاميرا ✅");
    log("SWITCH_COMPLETED", { facingMode: currentFacingMode });
  } catch (error) {
    console.error("[WebRTC] SWITCH_FAILED", error?.stack || error);

    try {
      if (sender && replacedSuccessfully && previousVideoTrack && previousVideoTrack.readyState === "live") {
        await sender.replaceTrack(previousVideoTrack);
      }
    } catch (restoreTrackError) {
      console.error("[WebRTC] failed to restore previous camera track", restoreTrackError);
    }

    if (nextStream) {
      nextStream.getTracks().forEach((track) => {
        if (track !== nextVideoTrack && track.readyState === "live") {
          track.stop();
        }
      });
    }

    localStream = new MediaStream([previousVideoTrack, ...audioTracks.filter((track) => track.readyState === "live")]);
    currentFacingMode = previousFacingMode;

    if (localVideo) {
      localVideo.srcObject = localStream;
      if (typeof localVideo.play === "function") {
        await localVideo.play().catch(() => {});
      }
    }

    setStatus("تعذّر تبديل الكاميرا. أعد تشغيل الكاميرا وحاول مجددًا.");
  } finally {
    if (nextStream) {
      nextStream.getTracks().forEach((track) => {
        if (track !== nextVideoTrack && track.readyState === "live") {
          track.stop();
        }
      });
    }
    cameraSwitchInFlight = false;
  }
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
  if (roomOperationInFlight || roomId || sessionEnded === false && roomRole) return;
  roomOperationInFlight = true;

  sessionEnded = false;
  roomRole = "creator";

  try {
    await loadIceConfig();
    await ensureLocalStream();

    socket.emit("create-room", async (result) => {
      if (!result?.success) {
        roomRole = null;
        setStatus(result?.message || "تعذّر إنشاء الجلسة");
        roomOperationInFlight = false;
        return;
      }

      roomId = result.roomId;
      sessionToken = result.sessionToken;

      ensurePeerConnection();
      addLocalTracksOnce();
      showInvite(roomId);

      setStatus("تم إنشاء الجلسة. أرسل الرابط وانتظر انضمام الطرف الآخر.");
      log("ROOM_CREATED", roomId);
      roomOperationInFlight = false;
    });
  } catch (error) {
    console.error("[WebRTC] createRoom failed", error);
    roomRole = null;
    setStatus("تعذّر إنشاء الجلسة");
    roomOperationInFlight = false;
  }
