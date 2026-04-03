(function () {
  var socket = null;
  var inRoom = false;
  var roomId = '';
  var joinedRole = 'viewer';
  var isHost = false;
  var isMicOn = false;
  var isSharing = false;
  var isCamOn = false;
  var viewerFullscreen = false;
  var viewerSideHidden = false;
  var localAudioStream = null;
  var screenStream = null;
  var camStream = null;
  var remoteHostName = 'Host';
  var hostId = null;
  var participants = [];

  var peers = new Map();
  var mixedAudioContext = null;
  var mixedAudioDestination = null;
  var mixedMicSource = null;
  var mixedScreenSource = null;
  var mixedOutgoingTrack = null;

  var remoteScreenStream = new MediaStream();
  var remoteCamStream = new MediaStream();

  var els = {
    nameInput: document.getElementById('nameInput'),
    roomInput: document.getElementById('roomInput'),
    passwordInput: document.getElementById('passwordInput'),
    deviceMode: document.getElementById('deviceMode'),
    generateRoomBtn: document.getElementById('generateRoomBtn'),
    copyRoomBtn: document.getElementById('copyRoomBtn'),
    joinBtn: document.getElementById('joinBtn'),
    shareBtn: document.getElementById('shareBtn'),
    micBtn: document.getElementById('micBtn'),
    camBtn: document.getElementById('camBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    remoteVideo: document.getElementById('remoteVideo'),
    camVideo: document.getElementById('camVideo'),
    remoteAudio: document.getElementById('remoteAudio'),
    status: document.getElementById('status'),
    remoteState: document.getElementById('remoteState'),
    camState: document.getElementById('camState'),
    countValue: document.getElementById('countValue'),
    roleValue: document.getElementById('roleValue'),
    roomsContainer: document.getElementById('roomsContainer'),
    refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
    screenTitle: document.getElementById('screenTitle'),
    camTitle: document.getElementById('camTitle'),
    viewerFullscreenBtn: document.getElementById('viewerFullscreenBtn'),
    toggleSideBtn: document.getElementById('toggleSideBtn'),
    camPlaceholder: document.getElementById('camPlaceholder'),
    hostInitials: document.getElementById('hostInitials'),
    hostDisplayName: document.getElementById('hostDisplayName'),
    peopleStrip: document.getElementById('peopleStrip')
  };

  function sanitizeRoomId(value) {
    return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }
  function shortCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = '';
    for (var i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }
  function setStatus(msg) { if (els.status) els.status.textContent = msg; }
  function setCount(n) { if (els.countValue) els.countValue.textContent = String(n || 0); }
  function setRoleText(role) { if (els.roleValue) els.roleValue.textContent = role === 'host' ? 'Host' : 'Viewer'; }
  function setRemoteState(text) { if (els.remoteState) els.remoteState.textContent = text; }
  function setCamState(text) { if (els.camState) els.camState.textContent = text; }
  function safePlay(media) { if (media && media.play) media.play().catch(function () { }); }
  function isProbablyAndroid() { return /Android/i.test(navigator.userAgent || ''); }

  function nameToInitials(name) {
    var parts = String(name || 'Host').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (!parts.length) return 'H';
    return parts.map(function (part) { return part.charAt(0).toUpperCase(); }).join('');
  }
  function updateHostIdentity(name) {
    remoteHostName = String(name || remoteHostName || 'Host').trim() || 'Host';
    if (els.hostDisplayName) els.hostDisplayName.textContent = remoteHostName;
    if (els.hostInitials) els.hostInitials.textContent = nameToInitials(remoteHostName);
  }
  function updateCamPlaceholder() {
    if (!els.camPlaceholder) return;
    var show = !isHost && !isCamOn;
    els.camPlaceholder.classList.toggle('show', !!show);
    if (els.camVideo) els.camVideo.style.display = show ? 'none' : 'block';
  }

  function participantRoleText(role, me) {
    if (me) return role === 'host' ? 'You • host' : 'You';
    return role === 'host' ? 'Host' : 'Viewer';
  }
  function renderParticipants() {
    if (!els.peopleStrip) return;
    var list = [];
    if (inRoom && socket && socket.id) {
      var myName = String(els.nameInput && els.nameInput.value || 'You').trim() || 'You';
      list.push({ id: socket.id, role: joinedRole || (isHost ? 'host' : 'viewer'), displayName: myName, me: true });
    }
    participants.forEach(function (p) {
      if (!socket || p.id !== socket.id) list.push({ id: p.id, role: p.role, displayName: p.displayName, me: false });
    });
    if (!list.length) {
      els.peopleStrip.innerHTML = '<div style="color:var(--muted);font-size:13px">No one in room yet.</div>';
      return;
    }
    els.peopleStrip.innerHTML = list.map(function (p) {
      var cls = 'person-chip' + (p.role === 'host' ? ' host' : '') + (p.me ? ' me' : '');
      return '<div class="' + cls + '"><div class="person-avatar">' + nameToInitials(p.displayName || (p.role === 'host' ? 'Host' : 'Viewer')) + '</div><div class="person-name">' + (p.displayName || 'Guest') + '</div><div class="person-role">' + participantRoleText(p.role, p.me) + '</div></div>';
    }).join('');
  }
  function upsertParticipant(meta) {
    if (!meta || !meta.id) return;
    var found = false;
    participants = participants.map(function (p) {
      if (p.id === meta.id) { found = true; return { id: meta.id, role: meta.role || p.role || 'viewer', displayName: meta.displayName || p.displayName || 'Guest' }; }
      return p;
    });
    if (!found) participants.push({ id: meta.id, role: meta.role || 'viewer', displayName: meta.displayName || 'Guest' });
    renderParticipants();
  }
  function removeParticipant(id) {
    participants = participants.filter(function (p) { return p.id !== id; });
    renderParticipants();
  }
  function setParticipants(list) {
    participants = (list || []).filter(Boolean).map(function (p) { return { id: p.id, role: p.role || 'viewer', displayName: p.displayName || 'Guest' }; });
    var host = participants.find(function (p) { return p.role === 'host'; });
    if (host && (!isHost || (socket && host.id !== socket.id))) {
      hostId = host.id;
      updateHostIdentity(host.displayName);
    }
    renderParticipants();
  }

  function syncViewerFullscreenUi() {
    var viewerMode = inRoom && !isHost;
    if (els.viewerFullscreenBtn) els.viewerFullscreenBtn.hidden = !viewerMode;
    if (els.toggleSideBtn) els.toggleSideBtn.hidden = !viewerMode || !viewerFullscreen;
    if (els.viewerFullscreenBtn) els.viewerFullscreenBtn.textContent = viewerFullscreen ? 'Exit fullscreen' : 'Fullscreen';
    if (els.toggleSideBtn) els.toggleSideBtn.textContent = viewerSideHidden ? 'Show people' : 'Hide people';
    document.body.classList.toggle('viewer-fullscreen', viewerMode && viewerFullscreen);
    document.body.classList.toggle('side-hidden', viewerMode && viewerFullscreen && viewerSideHidden);
  }
  async function toggleViewerFullscreen() {
    if (isHost || !inRoom) return;
    viewerFullscreen = !viewerFullscreen;
    viewerSideHidden = false;
    syncViewerFullscreenUi();
    var target = document.documentElement;
    try {
      if (viewerFullscreen) {
        if (target.requestFullscreen && !document.fullscreenElement) await target.requestFullscreen();
      } else if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch (e) {}
    safePlay(els.remoteVideo);
    safePlay(els.camVideo);
  }
  function toggleViewerSide() {
    if (isHost || !inRoom || !viewerFullscreen) return;
    viewerSideHidden = !viewerSideHidden;
    syncViewerFullscreenUi();
  }

  function supportsDisplayMedia() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  function createSilentAudioTrack() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    var ctx = new AC();
    var oscillator = ctx.createOscillator();
    var dst = ctx.createMediaStreamDestination();
    oscillator.frequency.value = 0;
    oscillator.connect(dst);
    oscillator.start();
    var track = dst.stream.getAudioTracks()[0];
    track.enabled = false;
    track.stopContext = function () {
      try { oscillator.stop(); } catch (e) {}
      try { ctx.close(); } catch (e) {}
    };
    return track;
  }

  function ensureMixedDestination() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!mixedAudioContext || mixedAudioContext.state === 'closed') mixedAudioContext = new AC();
    if (!mixedAudioDestination) mixedAudioDestination = mixedAudioContext.createMediaStreamDestination();
    return mixedAudioDestination;
  }

  function ensurePeerAudioElement(peerId) {
    var peer = peers.get(peerId);
    if (!peer) return null;
    if (peer.audioEl) return peer.audioEl;
    var audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.hidden = true;
    audio.setAttribute('data-peer-audio', peerId);
    document.body.appendChild(audio);
    peer.audioEl = audio;
    return audio;
  }

  function attachIncomingAudio(peerId) {
    var peer = peers.get(peerId);
    if (!peer) return;
    var audioEl = ensurePeerAudioElement(peerId);
    if (!audioEl) return;
    audioEl.srcObject = peer.incomingAudio;
    safePlay(audioEl);
  }

  function clearRemoteDisplay() {
    remoteScreenStream = new MediaStream();
    remoteCamStream = new MediaStream();
    if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
    if (els.camVideo) els.camVideo.srcObject = remoteCamStream;
    setRemoteState('Waiting');
    setCamState('Off');
    isCamOn = false;
    updateCamPlaceholder();
  }

  function setupRemoteMediaBindings() {
    if (els.remoteVideo) {
      els.remoteVideo.srcObject = remoteScreenStream;
      els.remoteVideo.muted = !!isHost;
    }
    if (els.camVideo) {
      els.camVideo.srcObject = isHost ? camStream : remoteCamStream;
      els.camVideo.muted = true;
    }
    if (els.remoteAudio) {
      els.remoteAudio.autoplay = true;
      els.remoteAudio.playsInline = true;
    }
    updateCamPlaceholder();
  }

  function getPeerLabel(peerId) {
    var peer = peers.get(peerId);
    return peer ? (peer.displayName || peer.role || 'peer') : 'peer';
  }

  function isHostRelation(peer) {
    return !!peer && (peer.role === 'host' || isHost);
  }

  function shouldHaveCamPc(peer) {
    return !!peer && isHostRelation(peer);
  }

  function shouldInitiateMain(peerId) {
    var peer = peers.get(peerId);
    if (!peer || !socket || !socket.id) return false;
    if (isHost) return true;
    if (peer.role === 'host') return false;
    return String(socket.id) < String(peerId);
  }

  function shouldInitiateCam(peerId) {
    var peer = peers.get(peerId);
    return !!(isHost && peer && peer.role === 'viewer');
  }

  function ensurePeerRecord(peerId, meta) {
    var peer = peers.get(peerId);
    if (!peer) {
      peer = {
        id: peerId,
        role: meta && meta.role ? meta.role : 'viewer',
        displayName: meta && meta.displayName ? meta.displayName : 'Guest',
        incomingAudio: new MediaStream(),
        incomingMain: new MediaStream(),
        incomingCam: new MediaStream(),
        pending: { main: [], cam: [] },
        makingOffer: { main: false, cam: false },
        ignoreOffer: { main: false, cam: false },
        pcs: { main: null, cam: null },
        senders: { mainAudio: null, mainVideo: null, camVideo: null },
        audioEl: null
      };
      peers.set(peerId, peer);
    } else if (meta) {
      if (meta.role) peer.role = meta.role;
      if (meta.displayName) peer.displayName = meta.displayName;
    }
    if (peer.role === 'host') {
      hostId = peerId;
      updateHostIdentity(peer.displayName);
    }
    return peer;
  }

  function destroyPeer(peerId) {
    var peer = peers.get(peerId);
    if (!peer) return;
    ['main', 'cam'].forEach(function (kind) {
      var pc = peer.pcs[kind];
      if (pc) {
        try { pc.ontrack = null; pc.onicecandidate = null; pc.onnegotiationneeded = null; pc.onconnectionstatechange = null; pc.close(); } catch (e) {}
      }
    });
    if (peer.audioEl && peer.audioEl.parentNode) peer.audioEl.parentNode.removeChild(peer.audioEl);
    peers.delete(peerId);
    if (hostId === peerId) {
      hostId = null;
      clearRemoteDisplay();
    }
  }

  async function ensureLocalAudio() {
    if (localAudioStream && localAudioStream.getAudioTracks().length) return localAudioStream;
    localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    localAudioStream.getAudioTracks().forEach(function (track) { track.enabled = !!isMicOn; });
    rebuildOutgoingAudioTrack();
    refreshAllPeerTracks();
    return localAudioStream;
  }

  function stopLocalAudio() {
    if (localAudioStream) {
      localAudioStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    localAudioStream = null;
    rebuildOutgoingAudioTrack();
  }

  function rebuildOutgoingAudioTrack() {
    var mix = ensureMixedDestination();
    if (!mix) return null;
    if (mixedMicSource) { try { mixedMicSource.disconnect(); } catch (e) {} mixedMicSource = null; }
    if (mixedScreenSource) { try { mixedScreenSource.disconnect(); } catch (e) {} mixedScreenSource = null; }

    if (localAudioStream && localAudioStream.getAudioTracks().length) {
      try {
        mixedMicSource = mixedAudioContext.createMediaStreamSource(localAudioStream);
        mixedMicSource.connect(mixedAudioDestination);
      } catch (e) {}
    }
    if (isHost && screenStream && screenStream.getAudioTracks().length) {
      try {
        mixedScreenSource = mixedAudioContext.createMediaStreamSource(screenStream);
        mixedScreenSource.connect(mixedAudioDestination);
      } catch (e) {}
    }

    var newTrack = mixedAudioDestination.stream.getAudioTracks()[0] || null;
    if (newTrack) newTrack.enabled = true;
    mixedOutgoingTrack = newTrack;
    peers.forEach(function (peer) {
      if (peer.senders.mainAudio) {
        try { peer.senders.mainAudio.replaceTrack(newTrack || null); } catch (e) {}
      }
    });
    return newTrack;
  }

  function getOutgoingAudioTrack() {
    if (mixedOutgoingTrack) return mixedOutgoingTrack;
    rebuildOutgoingAudioTrack();
    return mixedOutgoingTrack;
  }

  function syncMicState() {
    if (localAudioStream) {
      localAudioStream.getAudioTracks().forEach(function (track) { track.enabled = !!isMicOn; });
    }
    if (els.micBtn) {
      els.micBtn.textContent = isMicOn ? 'Mic on' : 'Mic off';
      els.micBtn.className = isMicOn ? 'warning' : 'success';
    }
  }

  function updateButtons() {
    if (els.shareBtn) {
      els.shareBtn.disabled = !inRoom || !isHost;
      els.shareBtn.textContent = isSharing ? 'Stop screen share' : (supportsDisplayMedia() ? 'Start screen share' : 'Screen share unsupported');
    }
    if (els.camBtn) {
      els.camBtn.disabled = !inRoom || !isHost;
      els.camBtn.textContent = isCamOn ? 'Stop camera' : 'Start camera';
      els.camBtn.className = isCamOn ? 'warning' : 'secondary';
    }
    if (els.micBtn) {
      els.micBtn.disabled = !inRoom;
      syncMicState();
    }
    if (els.leaveBtn) els.leaveBtn.disabled = !inRoom;
    setRoleText(joinedRole);
    syncViewerFullscreenUi();
    updateCamPlaceholder();
  }

  function sendSignal(to, data) {
    if (!socket || !to) return;
    socket.emit('signal', { to: to, data: data });
  }

  function createPc(peerId, kind) {
    var config = (window.WATCH_ROOM_CONFIG && window.WATCH_ROOM_CONFIG.iceServers) ? { iceServers: window.WATCH_ROOM_CONFIG.iceServers } : undefined;
    var peer = ensurePeerRecord(peerId);
    if (peer.pcs[kind]) return peer.pcs[kind];
    var pc = new RTCPeerConnection(config);
    peer.pcs[kind] = pc;

    pc.onicecandidate = function (event) {
      if (event.candidate) sendSignal(peerId, { kind: kind, candidate: event.candidate });
    };

    pc.onnegotiationneeded = function () {
      if ((kind === 'main' && shouldInitiateMain(peerId)) || (kind === 'cam' && shouldInitiateCam(peerId))) {
        negotiate(peerId, kind);
      }
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        if (kind === 'main') {
          if (peer.role === 'host' && !isHost) setRemoteState('Reconnecting');
        }
      }
    };

    pc.ontrack = function (event) {
      if (kind === 'main') {
        event.streams[0].getAudioTracks().forEach(function (track) {
          if (!peer.incomingAudio.getTracks().find(function (t) { return t.id === track.id; })) peer.incomingAudio.addTrack(track);
        });
        attachIncomingAudio(peerId);

        if (peer.role === 'host' && !isHost) {
          event.streams[0].getVideoTracks().forEach(function (track) {
            remoteScreenStream = new MediaStream([track]);
            if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
            setRemoteState('Live');
            safePlay(els.remoteVideo);
          });
        }
      } else if (kind === 'cam' && peer.role === 'host' && !isHost) {
        event.streams[0].getVideoTracks().forEach(function (track) {
          remoteCamStream = new MediaStream([track]);
          if (els.camVideo) els.camVideo.srcObject = remoteCamStream;
          isCamOn = true;
          setCamState('Live');
          updateCamPlaceholder();
          safePlay(els.camVideo);
        });
      }
    };

    if (kind === 'main') {
      var outgoingAudio = getOutgoingAudioTrack();
      if (outgoingAudio) {
        peer.senders.mainAudio = pc.addTrack(outgoingAudio, mixedAudioDestination ? mixedAudioDestination.stream : new MediaStream([outgoingAudio]));
      } else {
        var silentTrack = createSilentAudioTrack();
        if (silentTrack) peer.senders.mainAudio = pc.addTrack(silentTrack, new MediaStream([silentTrack]));
      }
      if (isHostRelation(peer) && isHost && screenStream && screenStream.getVideoTracks().length) {
        peer.senders.mainVideo = pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
      }
    }

    if (kind === 'cam' && shouldHaveCamPc(peer) && isHost && camStream && camStream.getVideoTracks().length) {
      peer.senders.camVideo = pc.addTrack(camStream.getVideoTracks()[0], camStream);
    }

    return pc;
  }

  async function negotiate(peerId, kind) {
    var peer = ensurePeerRecord(peerId);
    var pc = createPc(peerId, kind);
    if (!pc || pc.signalingState === 'closed') return;
    try {
      peer.makingOffer[kind] = true;
      var offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      sendSignal(peerId, { kind: kind, description: pc.localDescription });
    } catch (e) {
    } finally {
      peer.makingOffer[kind] = false;
    }
  }

  async function handleSignal(from, data) {
    var kind = data.kind || 'main';
    var peer = ensurePeerRecord(from);
    var pc = createPc(from, kind);
    var polite = socket && socket.id && socket.id > from;

    if (data.description) {
      var description = data.description;
      var offerCollision = description.type === 'offer' && (peer.makingOffer[kind] || pc.signalingState !== 'stable');
      peer.ignoreOffer[kind] = !polite && offerCollision;
      if (peer.ignoreOffer[kind]) return;
      try {
        if (offerCollision && polite) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(description)
          ]);
        } else {
          await pc.setRemoteDescription(description);
        }
        while (peer.pending[kind].length) {
          var c = peer.pending[kind].shift();
          try { await pc.addIceCandidate(c); } catch (e) {}
        }
        if (description.type === 'offer') {
          await refreshPeerTracks(from);
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal(from, { kind: kind, description: pc.localDescription });
        }
      } catch (e) {
        setStatus('Signal sync retrying for ' + getPeerLabel(from) + '.');
        if (description.type === 'offer' && polite) {
          try {
            await refreshPeerTracks(from);
            await negotiate(from, kind);
          } catch (err) {}
        }
      }
    } else if (data.candidate) {
      try {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(data.candidate);
        } else {
          peer.pending[kind].push(data.candidate);
        }
      } catch (e) {}
    }
  }

  async function refreshPeerTracks(peerId) {
    var peer = peers.get(peerId);
    if (!peer) return;
    var mainPc = createPc(peerId, 'main');
    var outgoingAudio = getOutgoingAudioTrack();
    if (peer.senders.mainAudio) {
      try { await peer.senders.mainAudio.replaceTrack(outgoingAudio || null); } catch (e) {}
    } else if (outgoingAudio) {
      peer.senders.mainAudio = mainPc.addTrack(outgoingAudio, mixedAudioDestination ? mixedAudioDestination.stream : new MediaStream([outgoingAudio]));
    }

    if (isHost && peer.role === 'viewer') {
      var screenTrack = screenStream && screenStream.getVideoTracks()[0] ? screenStream.getVideoTracks()[0] : null;
      if (peer.senders.mainVideo) {
        try { await peer.senders.mainVideo.replaceTrack(screenTrack || null); } catch (e) {}
      } else if (screenTrack) {
        peer.senders.mainVideo = mainPc.addTrack(screenTrack, screenStream);
      }
      if (!screenTrack && peer.senders.mainVideo) { try { await peer.senders.mainVideo.replaceTrack(null); } catch (e) {} }

      var camPc = createPc(peerId, 'cam');
      var camTrack = camStream && camStream.getVideoTracks()[0] ? camStream.getVideoTracks()[0] : null;
      if (peer.senders.camVideo) {
        try { await peer.senders.camVideo.replaceTrack(camTrack || null); } catch (e) {}
      } else if (camTrack) {
        peer.senders.camVideo = camPc.addTrack(camTrack, camStream);
      }
      if (!camTrack && peer.senders.camVideo) { try { await peer.senders.camVideo.replaceTrack(null); } catch (e) {} }
    }
  }

  function refreshAllPeerTracks() {
    peers.forEach(function (_peer, peerId) {
      refreshPeerTracks(peerId);
    });
  }

  var mediaSyncTimer = null;
  function scheduleMediaSyncRequest(reason) {
    if (isHost || !socket || !hostId) return;
    if (mediaSyncTimer) clearTimeout(mediaSyncTimer);
    mediaSyncTimer = setTimeout(function () {
      var hasRemoteScreen = !!(remoteScreenStream && remoteScreenStream.getVideoTracks && remoteScreenStream.getVideoTracks().length);
      if (!hasRemoteScreen && inRoom && hostId) {
        socket.emit('request-media-sync', { roomId: roomId, targetId: socket.id, reason: reason || 'retry' });
        setRemoteState('Receiving');
      }
    }, 1800);
  }

  function bindSocketEvents() {
    if (!socket || socket.__watchRoomBound) return;
    socket.__watchRoomBound = true;

    socket.on('connect', function () {
      socket.emit('get-room-list');
      if (!inRoom) setStatus('Ready to join.');
    });
    socket.on('room-list', renderRoomList);
    socket.on('room-error', function (msg) {
      setStatus(msg || 'Unable to join room.');
      inRoom = false;
      updateButtons();
    });
    socket.on('joined-room', async function (payload) {
      inRoom = true;
      roomId = payload.roomId;
      joinedRole = payload.isHost ? 'host' : 'viewer';
      isHost = !!payload.isHost;
      setCount(payload.count || 1);
      setRoleText(joinedRole);
      setStatus('Joined room ' + roomId + '.');
      if (els.roomInput) els.roomInput.value = roomId;
      if (els.deviceMode) els.deviceMode.value = joinedRole;
      setParticipants((payload.participants || []).filter(function (p) { return !socket || p.id !== socket.id; }));
      if (isHost) {
        hostId = socket.id;
        updateHostIdentity(String(els.nameInput && els.nameInput.value || 'Host'));
        if (els.screenTitle) els.screenTitle.textContent = 'Your shared screen';
        if (els.camTitle) els.camTitle.textContent = 'Your camera';
        setRemoteState(payload.mediaState && payload.mediaState.screenActive ? 'Live' : 'Not sharing');
        setCamState(payload.mediaState && payload.mediaState.camActive ? 'Live' : 'Off');
      } else {
        if (els.screenTitle) els.screenTitle.textContent = 'Shared screen';
        if (els.camTitle) els.camTitle.textContent = 'Host camera';
        setRemoteState(payload.mediaState && payload.mediaState.screenActive ? 'Receiving' : 'Waiting');
        setCamState(payload.mediaState && payload.mediaState.camActive ? 'Receiving' : 'Off');
      }
      (payload.peers || []).forEach(function (peerMeta) {
        ensurePeerRecord(peerMeta.id, { role: peerMeta.role, displayName: peerMeta.displayName });
      });
      updateButtons();
      setupRemoteMediaBindings();
      for (var i = 0; i < (payload.peers || []).length; i++) {
        var peerMeta = payload.peers[i];
        await refreshPeerTracks(peerMeta.id);
        if (shouldInitiateMain(peerMeta.id)) await negotiate(peerMeta.id, 'main');
        if (shouldInitiateCam(peerMeta.id)) await negotiate(peerMeta.id, 'cam');
      }
      if (!isHost && payload.mediaState && payload.mediaState.screenActive && payload.mediaState.hostId) {
        scheduleMediaSyncRequest('join-room');
      }
    });
    socket.on('peer-joined', async function (payload) {
      setCount(payload.count || 0);
      ensurePeerRecord(payload.socketId, { role: payload.role, displayName: payload.displayName });
      upsertParticipant({ id: payload.socketId, role: payload.role, displayName: payload.displayName });
      if (payload.role === 'host') {
        hostId = payload.socketId;
        updateHostIdentity(payload.displayName);
      }
      await refreshPeerTracks(payload.socketId);
      if (shouldInitiateMain(payload.socketId)) await negotiate(payload.socketId, 'main');
      if (shouldInitiateCam(payload.socketId)) await negotiate(payload.socketId, 'cam');
      setStatus((payload.displayName || 'Someone') + ' joined the room.');
      if (!isHost && payload.role === 'host') scheduleMediaSyncRequest('peer-joined');
    });
    socket.on('peer-left', function (payload) {
      setCount(payload.count || 0);
      destroyPeer(payload.socketId);
      removeParticipant(payload.socketId);
      setStatus('A participant left the room.');
    });
    socket.on('peer-count', function (payload) { setCount(payload.count || 0); });
    socket.on('signal', function (payload) { handleSignal(payload.from, payload.data || {}); });
    socket.on('room-state', function (payload) {
      if (payload && payload.participants) setParticipants((payload.participants || []).filter(function (p) { return !socket || p.id !== socket.id; }));
      if (payload && payload.mediaState && !isHost) {
        setRemoteState(payload.mediaState.screenActive ? 'Receiving' : 'Waiting');
        setCamState(payload.mediaState.camActive ? 'Receiving' : 'Off');
        if (payload.mediaState.hostId) hostId = payload.mediaState.hostId;
        if (payload.mediaState.screenActive) scheduleMediaSyncRequest('room-state');
        if (!payload.mediaState.screenActive) {
          remoteScreenStream = new MediaStream();
          if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
        }
        if (!payload.mediaState.camActive) {
          remoteCamStream = new MediaStream();
          if (els.camVideo) els.camVideo.srcObject = remoteCamStream;
          isCamOn = false;
          updateCamPlaceholder();
        }
      }
    });
    socket.on('sync-media-request', async function (payload) {
      if (!isHost || !payload || !payload.targetId) return;
      await refreshPeerTracks(payload.targetId);
      await negotiate(payload.targetId, 'main');
      if ((payload.camActive || isCamOn) && peers.get(payload.targetId) && peers.get(payload.targetId).role === 'viewer') {
        await negotiate(payload.targetId, 'cam');
      }
    });
    socket.on('media-state', function (payload) {
      var peer = ensurePeerRecord(payload.from);
      if (peer.role === 'host' && !isHost) {
        if (payload.screenActive) {
          setRemoteState('Receiving');
          hostId = payload.from;
          scheduleMediaSyncRequest('media-state');
        } else {
          remoteScreenStream = new MediaStream();
          if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
          setRemoteState('Waiting');
        }
        isCamOn = !!payload.camActive;
        setCamState(isCamOn ? 'Receiving' : 'Off');
        if (!isCamOn) {
          remoteCamStream = new MediaStream();
          if (els.camVideo) els.camVideo.srcObject = remoteCamStream;
        }
        updateCamPlaceholder();
      }
    });
    socket.on('disconnect', function () {
      if (inRoom) {
        cleanupRoomState(false);
        setStatus('Disconnected from room.');
      }
      participants = [];
      renderParticipants();
    });
  }

  function ensureSocket() {
    if (socket && socket.connected) return socket;
    if (!socket) socket = io();
    if (!socket.connected) socket.connect();
    bindSocketEvents();
    return socket;
  }

  async function joinRoom() {
    var nextRoomId = sanitizeRoomId(els.roomInput && els.roomInput.value);
    var displayName = String(els.nameInput && els.nameInput.value || 'Guest').trim() || 'Guest';
    var password = String(els.passwordInput && els.passwordInput.value || '');
    var requestedRole = els.deviceMode && els.deviceMode.value === 'host' ? 'host' : 'viewer';
    if (!nextRoomId) {
      setStatus('Enter a room code first.');
      return;
    }
    if (inRoom) return;

    try {
      await ensureLocalAudio();
    } catch (e) {
      setStatus('Mic permission is required to join the room.');
      return;
    }

    ensureSocket();
    if (socket.connected) {
      socket.emit('join-room', { roomId: nextRoomId, displayName: displayName, requestedRole: requestedRole, password: password });
      socket.emit('get-room-list');
    } else {
      socket.once('connect', function () {
        socket.emit('join-room', { roomId: nextRoomId, displayName: displayName, requestedRole: requestedRole, password: password });
        socket.emit('get-room-list');
      });
    }
    setStatus('Joining room ' + nextRoomId + '...');
  }

  async function startStopMic() {
    if (!inRoom) return;
    try {
      await ensureLocalAudio();
      isMicOn = !isMicOn;
      syncMicState();
      rebuildOutgoingAudioTrack();
      refreshAllPeerTracks();
      setStatus(isMicOn ? 'Mic is on.' : 'Mic is off.');
    } catch (e) {
      setStatus('Unable to access microphone.');
    }
  }

  async function startStopShare() {
    if (!inRoom || !isHost) return;
    if (!supportsDisplayMedia()) {
      setStatus(isProbablyAndroid() ? 'This Android browser does not expose screen sharing here. Try latest Chrome over HTTPS.' : 'Screen sharing is not supported in this browser.');
      return;
    }
    if (isSharing) {
      stopScreenShare();
      return;
    }
    try {
      var constraints = { video: true, audio: true };
      screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      var videoTrack = screenStream.getVideoTracks()[0] || null;
      if (!videoTrack) {
        setStatus('Screen share started without a video track.');
        return;
      }
      isSharing = true;
      if (els.remoteVideo) {
        els.remoteVideo.srcObject = screenStream;
        els.remoteVideo.muted = true;
        safePlay(els.remoteVideo);
      }
      videoTrack.onended = stopScreenShare;
      rebuildOutgoingAudioTrack();
      refreshAllPeerTracks();
      peers.forEach(function (peer, peerId) { if (peer.role === 'viewer') negotiate(peerId, 'main'); });
      setRemoteState('Live');
      updateButtons();
      if (socket) socket.emit('media-state', { roomId: roomId, screenActive: true, camActive: !!isCamOn });
      setStatus(screenStream.getAudioTracks().length ? 'Screen share started with screen audio.' : 'Screen share started. Browser did not provide screen audio.');
    } catch (e) {
      setStatus('Screen share was cancelled or blocked.');
    }
  }

  function stopScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    screenStream = null;
    isSharing = false;
    rebuildOutgoingAudioTrack();
    refreshAllPeerTracks();
    if (els.remoteVideo) {
      els.remoteVideo.srcObject = isHost ? new MediaStream() : remoteScreenStream;
      if (!isHost) safePlay(els.remoteVideo);
    }
    setRemoteState(isHost ? 'Not sharing' : 'Waiting');
    updateButtons();
    if (socket) socket.emit('media-state', { roomId: roomId, screenActive: false, camActive: !!isCamOn });
  }

  async function startStopCam() {
    if (!inRoom || !isHost) return;
    if (isCamOn) {
      stopCamera();
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      isCamOn = true;
      if (els.camVideo) {
        els.camVideo.srcObject = camStream;
        els.camVideo.muted = true;
        safePlay(els.camVideo);
      }
      var track = camStream.getVideoTracks()[0];
      if (track) track.onended = stopCamera;
      refreshAllPeerTracks();
      peers.forEach(function (peer, peerId) { if (peer.role === 'viewer') negotiate(peerId, 'cam'); });
      setCamState('Live');
      updateCamPlaceholder();
      updateButtons();
      if (socket) socket.emit('media-state', { roomId: roomId, screenActive: !!isSharing, camActive: true });
      setStatus('Camera started.');
    } catch (e) {
      setStatus('Unable to access camera.');
    }
  }

  function stopCamera() {
    if (camStream) {
      camStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    camStream = null;
    isCamOn = false;
    refreshAllPeerTracks();
    if (els.camVideo) {
      els.camVideo.srcObject = isHost ? new MediaStream() : remoteCamStream;
      if (!isHost) safePlay(els.camVideo);
    }
    setCamState('Off');
    updateCamPlaceholder();
    updateButtons();
    if (socket) socket.emit('media-state', { roomId: roomId, screenActive: !!isSharing, camActive: false });
  }


  function cleanupRoomState(resetRoomId) {
    if (typeof resetRoomId === 'undefined') resetRoomId = true;
    peers.forEach(function (_peer, peerId) { destroyPeer(peerId); });
    peers.clear();
    inRoom = false;
    if (resetRoomId) roomId = '';
    joinedRole = els.deviceMode && els.deviceMode.value === 'host' ? 'host' : 'viewer';
    isHost = false;
    hostId = null;
    isSharing = false;
    isCamOn = false;
    viewerFullscreen = false;
    if (mediaSyncTimer) { clearTimeout(mediaSyncTimer); mediaSyncTimer = null; }
    viewerSideHidden = false;
    clearRemoteDisplay();
    stopScreenShare();
    stopCamera();
    stopLocalAudio();
    updateButtons();
  }

  function leaveRoom(manual) {
    if (typeof manual === 'undefined') manual = true;
    var leavingRoomId = roomId;
    cleanupRoomState(true);
    if (manual && socket && socket.connected && leavingRoomId) {
      socket.emit('leave-room');
      socket.emit('get-room-list');
    } else if (socket && socket.connected) {
      socket.emit('get-room-list');
    }
  }

  function renderRoomList(payload) {
    if (!els.roomsContainer) return;
    var rooms = payload && payload.rooms ? payload.rooms : [];
    if (!rooms.length) {
      els.roomsContainer.textContent = 'No active rooms yet.';
      return;
    }
    els.roomsContainer.innerHTML = '';
    rooms.forEach(function (room) {
      var row = document.createElement('div');
      row.className = 'room-item';
      var left = document.createElement('div');
      left.innerHTML = '<div class="room-code">' + room.roomId + '</div><div class="room-meta">' + (room.hasHost ? 'Host ready' : 'Waiting for host') + ' • ' + room.count + ' / 6 in room' + (room.locked ? ' • password' : '') + '</div>';
      var btn = document.createElement('button');
      btn.className = 'secondary';
      btn.style.padding = '9px 12px';
      btn.style.fontSize = '13px';
      btn.textContent = 'Use';
      btn.onclick = function () {
        if (els.roomInput) els.roomInput.value = room.roomId;
        if (room.hasHost && els.deviceMode && els.deviceMode.value === 'host') els.deviceMode.value = 'viewer';
      };
      row.appendChild(left);
      row.appendChild(btn);
      els.roomsContainer.appendChild(row);
    });
  }

  if (els.generateRoomBtn) els.generateRoomBtn.onclick = function () { if (els.roomInput) els.roomInput.value = shortCode(); };
  if (els.copyRoomBtn) els.copyRoomBtn.onclick = function () { var code = sanitizeRoomId(els.roomInput && els.roomInput.value); if (!code) return; navigator.clipboard.writeText(code).then(function () { setStatus('Room code copied.'); }).catch(function () { }); };
  if (els.joinBtn) els.joinBtn.onclick = joinRoom;
  if (els.leaveBtn) els.leaveBtn.onclick = function () { leaveRoom(true); setStatus('Left room.'); };
  if (els.micBtn) els.micBtn.onclick = startStopMic;
  if (els.shareBtn) els.shareBtn.onclick = startStopShare;
  if (els.camBtn) els.camBtn.onclick = startStopCam;
  if (els.refreshRoomsBtn) els.refreshRoomsBtn.onclick = function () { ensureSocket(); if (socket) socket.emit('get-room-list'); };
  if (els.viewerFullscreenBtn) els.viewerFullscreenBtn.onclick = toggleViewerFullscreen;
  if (els.toggleSideBtn) els.toggleSideBtn.onclick = toggleViewerSide;

  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && viewerFullscreen) {
      viewerFullscreen = false;
      viewerSideHidden = false;
      syncViewerFullscreenUi();
    }
  });

  ensureSocket();
  setupRemoteMediaBindings();
  clearRemoteDisplay();
  if (els.roomInput && !els.roomInput.value) els.roomInput.value = shortCode();
  updateButtons();
  renderParticipants();
  setStatus('Not connected.');
})();
