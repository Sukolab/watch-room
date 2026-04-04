(function () {
  var socket = null;
  var inRoom = false;
  var roomId = '';
  var joinedRole = 'viewer';
  var isHost = false;
  var isMicOn = false;
  var isSharing = false;
  var viewerFullscreen = false;
  var viewerSideHidden = false;
  var localAudioStream = null;
  var screenStream = null;
  var outboundScreenStream = null;
  var relayCanvas = null;
  var relayCanvasStream = null;
  var relayVideoEl = null;
  var relayDrawTimer = null;
  var relayAnimationHandle = null;
  var usingScreenRelay = false;
  var remoteHostName = 'Host';
  var hostId = null;
  var participants = [];
  var chatMessages = [];
  var roomHasSafari = false;
  var browserMeta = detectBrowserMeta();
  var forceH264Mode = false;
  var remoteVideoHealthTimer = null;
  var hasTurn = !!(window.WATCH_ROOM_CONFIG && window.WATCH_ROOM_CONFIG.hasTurn);
  var audioResumeHintShown = false;
  var restartAttempts = {};
  var restartCooldownMs = 2500;

  var peers = new Map();
  var mixedAudioContext = null;
  var mixedAudioDestination = null;
  var mixedMicSource = null;
  var mixedScreenSource = null;
  var mixedOutgoingTrack = null;

  var remoteScreenStream = new MediaStream();

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
    leaveBtn: document.getElementById('leaveBtn'),
    remoteVideo: document.getElementById('remoteVideo'),
    remoteAudio: document.getElementById('remoteAudio'),
    status: document.getElementById('status'),
    remoteState: document.getElementById('remoteState'),
    countValue: document.getElementById('countValue'),
    roleValue: document.getElementById('roleValue'),
    roomsContainer: document.getElementById('roomsContainer'),
    refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
    screenTitle: document.getElementById('screenTitle'),
    viewerFullscreenBtn: document.getElementById('viewerFullscreenBtn'),
    peopleStrip: document.getElementById('peopleStrip'),
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    sendChatBtn: document.getElementById('sendChatBtn'),
    resumeAudioBtn: document.getElementById('resumeAudioBtn'),
    netHint: document.getElementById('netHint')
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
  function safePlay(media) { if (media && media.play) media.play().catch(function () {
    if (!audioResumeHintShown && media && (media.tagName === 'AUDIO' || media.tagName === 'VIDEO')) {
      audioResumeHintShown = true;
      if (els.netHint) els.netHint.textContent = 'Tap Resume audio if your browser blocks remote sound.';
    }
  }); }
  function setNetworkHint(text) { if (els.netHint) els.netHint.textContent = text; }
  function resumeAudioPlayback() {
    try { if (mixedAudioContext && mixedAudioContext.state === 'suspended') mixedAudioContext.resume(); } catch (e) {}
    if (els.remoteAudio) { els.remoteAudio.muted = false; safePlay(els.remoteAudio); }
    if (els.remoteVideo) { safePlay(els.remoteVideo); }
    peers.forEach(function (peer) {
      if (peer && peer.audioEl) {
        try { peer.audioEl.muted = false; peer.audioEl.volume = 1; } catch (e) {}
        safePlay(peer.audioEl);
      }
    });
    setNetworkHint(hasTurn ? 'Remote audio resumed. If one side still cannot hear, check mic permission on both browsers.' : 'Remote audio resumed. Direct mode is active. Different networks can take a moment to reconnect.');
  }
  function updateNetworkHint() {
    if (!inRoom) {
      setNetworkHint(hasTurn ? 'Relay server is configured. Cross-network calls should be more reliable.' : 'Direct STUN mode is active. No account or paid relay is required, but some networks may need a reconnect.');
      return;
    }
    if (!hasTurn) {
      setNetworkHint('Direct STUN mode is active. Same Wi-Fi is not required, but some network pairs may need a quick reconnect or refresh.');
    } else {
      setNetworkHint('Relay server is configured. If audio is blocked, tap Resume audio once.');
    }
  }
  function tryIceRestart(peerId, kind, reason) {
    var key = String(peerId || '') + ':' + String(kind || 'main');
    var now = Date.now();
    if (restartAttempts[key] && now - restartAttempts[key] < restartCooldownMs) return;
    restartAttempts[key] = now;
    var peer = peers.get(peerId);
    if (!peer) return;
    var pc = peer.pcs[kind];
    if (!pc || pc.signalingState === 'closed') return;
    try { if (pc.restartIce) pc.restartIce(); } catch (e) {}
    if ((kind === 'main' && shouldInitiateMain(peerId))) {
      setTimeout(function () { negotiate(peerId, kind); }, 120);
    } else if (!isHost && kind === 'main' && socket && hostId) {
      socket.emit('request-media-sync', { roomId: roomId, targetId: socket.id, reason: reason || 'ice-restart', preferCodec: forceH264Mode ? 'H264' : 'default' });
    }
  }

  function maybeWarnConnection(kind, state, peer) {
    if (state !== 'failed' && state !== 'disconnected') return;
    var label = peer ? (peer.displayName || peer.role || 'peer') : 'peer';
    if (!hasTurn) {
      setStatus('Connection dipped with ' + label + '. Trying a direct reconnect.');
      updateNetworkHint();
    } else if (kind === 'main' && peer && peer.role === 'host' && !isHost) {
      setStatus('Reconnecting media from ' + label + '.');
    }
  }
  function isProbablyAndroid() { return /Android/i.test(navigator.userAgent || ''); }
  function detectBrowserMeta() {
    var ua = navigator.userAgent || '';
    var vendor = navigator.vendor || '';
    var isIOS = /iPad|iPhone|iPod/i.test(ua);
    var isAndroid = /Android/i.test(ua);
    var isEdge = /Edg\//i.test(ua);
    var isBrave = !!(navigator.brave && navigator.brave.isBrave);
    var isFirefox = /Firefox\//i.test(ua);
    var isSafari = !isEdge && !isBrave && !/Chrome\//i.test(ua) && /Safari\//i.test(ua) && /Apple/i.test(vendor);
    var isChrome = !isEdge && !isBrave && /Chrome\//i.test(ua);
    return {
      ua: ua,
      engine: isSafari ? 'safari' : isBrave ? 'brave' : isEdge ? 'edge' : isFirefox ? 'firefox' : isChrome ? 'chrome' : 'unknown',
      mobile: !!(isIOS || isAndroid),
      ios: !!isIOS,
      android: !!isAndroid
    };
  }

  function nameToInitials(name) {
    var parts = String(name || 'Host').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (!parts.length) return 'H';
    return parts.map(function (part) { return part.charAt(0).toUpperCase(); }).join('');
  }
  function updateHostIdentity(name) {
    remoteHostName = String(name || remoteHostName || 'Host').trim() || 'Host';
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
      if (p.id === meta.id) { found = true; return { id: meta.id, role: meta.role || p.role || 'viewer', displayName: meta.displayName || p.displayName || 'Guest', browser: meta.browser || p.browser || null }; }
      return p;
    });
    if (!found) participants.push({ id: meta.id, role: meta.role || 'viewer', displayName: meta.displayName || 'Guest', browser: meta.browser || null });
    updateRoomBrowserFlags();
    renderParticipants();
  }
  function removeParticipant(id) {
    participants = participants.filter(function (p) { return p.id !== id; });
    updateRoomBrowserFlags();
    renderParticipants();
  }
  function setParticipants(list) {
    participants = (list || []).filter(Boolean).map(function (p) { return { id: p.id, role: p.role || 'viewer', displayName: p.displayName || 'Guest', browser: p.browser || null }; });
    var host = participants.find(function (p) { return p.role === 'host'; });
    if (host && (!isHost || (socket && host.id !== socket.id))) {
      hostId = host.id;
      updateHostIdentity(host.displayName);
    }
    renderParticipants();
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] || ch;
    });
  }
  function renderChat() {
    if (!els.chatMessages) return;
    if (!chatMessages.length) {
      els.chatMessages.innerHTML = '<div style="color:var(--muted);font-size:13px">No messages yet.</div>';
      return;
    }
    els.chatMessages.innerHTML = chatMessages.map(function (m) {
      var mine = socket && m.from === socket.id;
      var who = mine ? 'You' : (m.name || 'Guest');
      var role = m.role === 'host' ? 'host' : 'viewer';
      return '<div class="chat-item' + (mine ? ' me' : '') + '"><div class="chat-meta">' + escapeHtml(who) + ' <span>• ' + role + '</span></div><div class="chat-text">' + escapeHtml(m.text) + '</div></div>';
    }).join('');
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }
  function setChatMessages(list) {
    chatMessages = Array.isArray(list) ? list.slice(-100) : [];
    renderChat();
  }
  function pushChatMessage(message) {
    if (!message) return;
    chatMessages.push(message);
    if (chatMessages.length > 100) chatMessages = chatMessages.slice(-100);
    renderChat();
  }
  function sendChat() {
    var text = String(els.chatInput && els.chatInput.value || '').trim();
    if (!inRoom || !socket || !text) return;
    socket.emit('chat-message', { roomId: roomId, text: text });
    if (els.chatInput) els.chatInput.value = '';
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
    audio.muted = false;
    audio.volume = 1;
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
    if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
    setRemoteState('Waiting');
  }

  function setupRemoteMediaBindings() {
    if (els.remoteVideo) {
      els.remoteVideo.srcObject = remoteScreenStream;
      els.remoteVideo.muted = !!isHost;
    }
    if (els.remoteAudio) {
      els.remoteAudio.autoplay = true;
      els.remoteAudio.playsInline = true;
      els.remoteAudio.muted = false;
      els.remoteAudio.volume = 1;
    }
  }

  function getPeerLabel(peerId) {
    var peer = peers.get(peerId);
    return peer ? (peer.displayName || peer.role || 'peer') : 'peer';
  }

  function isHostRelation(peer) {
    return !!peer && (peer.role === 'host' || isHost);
  }

  function shouldInitiateMain(peerId) {
    var peer = peers.get(peerId);
    if (!peer || !socket || !socket.id) return false;
    if (isHost) return true;
    if (peer.role === 'host') return false;
    return String(socket.id) < String(peerId);
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
        pending: { main: [] },
        makingOffer: { main: false },
        ignoreOffer: { main: false },
        pcs: { main: null },
        senders: { mainAudio: null, mainVideo: null },
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
    ['main'].forEach(function (kind) {
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
    if (els.micBtn) {
      els.micBtn.disabled = !inRoom;
      syncMicState();
    }
    if (els.leaveBtn) els.leaveBtn.disabled = !inRoom;
    if (els.sendChatBtn) els.sendChatBtn.disabled = !inRoom;
    if (els.chatInput) els.chatInput.disabled = !inRoom;
    setRoleText(joinedRole);
    syncViewerFullscreenUi();
  }

  function sendSignal(to, data) {
    if (!socket || !to) return;
    socket.emit('signal', { to: to, data: data });
  }

  function isDesktopChromium(meta) {
    var engine = meta && meta.engine;
    return !meta.mobile && (engine === 'chrome' || engine === 'edge' || engine === 'brave');
  }

  function shouldUseScreenRelay() {
    return !!(screenStream && isDesktopChromium(browserMeta));
  }

  function cleanupScreenRelay() {
    if (relayDrawTimer) { clearInterval(relayDrawTimer); relayDrawTimer = null; }
    if (relayAnimationHandle && window.cancelAnimationFrame) {
      try { cancelAnimationFrame(relayAnimationHandle); } catch (e) {}
      relayAnimationHandle = null;
    }
    if (relayCanvasStream) {
      relayCanvasStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    relayCanvasStream = null;
    outboundScreenStream = null;
    usingScreenRelay = false;
    if (relayVideoEl) {
      try { relayVideoEl.pause(); } catch (e) {}
      relayVideoEl.srcObject = null;
      if (relayVideoEl.parentNode) relayVideoEl.parentNode.removeChild(relayVideoEl);
    }
    relayVideoEl = null;
    if (relayCanvas && relayCanvas.parentNode) relayCanvas.parentNode.removeChild(relayCanvas);
    relayCanvas = null;
  }

  function getOutgoingScreenStream() {
    return outboundScreenStream || screenStream || null;
  }

  function getOutgoingScreenTrack() {
    var stream = getOutgoingScreenStream();
    return stream && stream.getVideoTracks()[0] ? stream.getVideoTracks()[0] : null;
  }

  async function buildScreenRelayStream() {
    cleanupScreenRelay();
    if (!screenStream) return null;
    var track = screenStream.getVideoTracks()[0];
    if (!track) return screenStream;
    var settings = track.getSettings ? track.getSettings() : {};
    var width = Math.min(settings.width || 1280, browserMeta.mobile ? 960 : 1280);
    var height = Math.min(settings.height || 720, browserMeta.mobile ? 540 : 720);
    var fps = Math.min(20, settings.frameRate || 20);
    relayVideoEl = document.createElement('video');
    relayVideoEl.autoplay = true;
    relayVideoEl.muted = true;
    relayVideoEl.playsInline = true;
    relayVideoEl.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    relayVideoEl.srcObject = screenStream;
    document.body.appendChild(relayVideoEl);
    try { await relayVideoEl.play(); } catch (e) {}

    relayCanvas = document.createElement('canvas');
    relayCanvas.width = Math.max(2, width);
    relayCanvas.height = Math.max(2, height);
    relayCanvas.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(relayCanvas);
    var ctx = relayCanvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx || !relayCanvas.captureStream) {
      cleanupScreenRelay();
      return screenStream;
    }
    var drawFrame = function () {
      if (!relayCanvas || !relayVideoEl) return;
      try {
        if (relayVideoEl.readyState >= 2 && relayVideoEl.videoWidth && relayVideoEl.videoHeight) {
          if (relayCanvas.width !== relayVideoEl.videoWidth || relayCanvas.height !== relayVideoEl.videoHeight) {
            relayCanvas.width = relayVideoEl.videoWidth;
            relayCanvas.height = relayVideoEl.videoHeight;
          }
          ctx.drawImage(relayVideoEl, 0, 0, relayCanvas.width, relayCanvas.height);
        }
      } catch (e) {}
    };
    drawFrame();
    relayCanvasStream = relayCanvas.captureStream(fps);
    outboundScreenStream = relayCanvasStream;
    usingScreenRelay = true;
    if (track.contentHint) {
      try { relayCanvasStream.getVideoTracks()[0].contentHint = 'detail'; } catch (e) {}
    }
    relayDrawTimer = setInterval(drawFrame, Math.max(30, Math.round(1000 / fps)));
    return outboundScreenStream;
  }

  function isSafariMeta(meta) {
    return !!(meta && meta.engine === 'safari');
  }
  function updateRoomBrowserFlags() {
    roomHasSafari = isSafariMeta(browserMeta) || participants.some(function (p) { return isSafariMeta(p.browser); });
    forceH264Mode = roomHasSafari;
  }
  function findVideoPayloadsByCodec(sdp, codecName) {
    var lines = String(sdp || '').split(/\r?\n/);
    var payloads = [];
    var rtxByApt = {};
    lines.forEach(function (line) {
      var m = line.match(/^a=rtpmap:(\d+)\s+([^/]+)/i);
      if (m && m[2].toUpperCase() === String(codecName || '').toUpperCase()) payloads.push(m[1]);
    });
    lines.forEach(function (line) {
      var fm = line.match(/^a=fmtp:(\d+)\s+(.+)$/i);
      if (!fm) return;
      var apt = fm[2].match(/apt=(\d+)/i);
      if (apt) rtxByApt[apt[1]] = fm[1];
    });
    var out = [];
    payloads.forEach(function (pt) {
      out.push(pt);
      if (rtxByApt[pt]) out.push(rtxByApt[pt]);
    });
    return out;
  }
  function reprioritizeVideoCodecInSdp(sdp, codecName) {
    if (!sdp) return sdp;
    var preferred = findVideoPayloadsByCodec(sdp, codecName);
    if (!preferred.length) return sdp;
    return String(sdp).split(/\r?\n/).map(function (line) {
      if (line.indexOf('m=video ') !== 0) return line;
      var parts = line.trim().split(/\s+/);
      if (parts.length <= 3) return line;
      var header = parts.slice(0, 3);
      var payloads = parts.slice(3);
      var ordered = preferred.filter(function (pt) { return payloads.indexOf(pt) >= 0; })
        .concat(payloads.filter(function (pt) { return preferred.indexOf(pt) < 0; }));
      return header.concat(ordered).join(' ');
    }).join('\r\n');
  }
  function maybePreferVideoCodec(description) {
    if (!description || !description.sdp) return description;
    var codec = forceH264Mode ? 'H264' : 'VP8';
    return { type: description.type, sdp: reprioritizeVideoCodecInSdp(description.sdp, codec) };
  }
  async function tuneSenderParameters(sender, kind) {
    if (!sender || !sender.getParameters || !sender.setParameters) return;
    try {
      var params = sender.getParameters() || {};
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      var mobileRoom = browserMeta.mobile || participants.some(function (p) { return p.browser && p.browser.mobile; });
      if (kind === 'screenVideo') {
        params.encodings[0].maxBitrate = mobileRoom ? 900000 : 1800000;
        params.encodings[0].maxFramerate = mobileRoom ? 20 : 30;
        params.degradationPreference = 'maintain-resolution';

        params.encodings[0].maxBitrate = mobileRoom ? 350000 : 700000;
        params.encodings[0].maxFramerate = mobileRoom ? 15 : 24;
        params.degradationPreference = 'balanced';
      } else if (kind === 'audio') {
        params.encodings[0].maxBitrate = 64000;
      }
      await sender.setParameters(params);
    } catch (e) {}
  }
  function scheduleRemoteVideoHealthCheck(reason) {
    if (remoteVideoHealthTimer) clearTimeout(remoteVideoHealthTimer);
    if (isHost) return;
    remoteVideoHealthTimer = setTimeout(function () {
      var video = els.remoteVideo;
      var hasTrack = !!(remoteScreenStream && remoteScreenStream.getVideoTracks && remoteScreenStream.getVideoTracks().length);
      var looksDead = !video || !hasTrack || video.readyState < 2 || !video.videoWidth;
      if (inRoom && hostId && looksDead && socket) {
        forceH264Mode = true;
        socket.emit('request-media-sync', { roomId: roomId, targetId: socket.id, reason: reason || 'video-health', preferCodec: 'H264' });
        setRemoteState('Receiving');
      }
    }, 2500);
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
      if ((kind === 'main' && shouldInitiateMain(peerId))) {
        negotiate(peerId, kind);
      }
    };

    pc.onconnectionstatechange = function () {
      maybeWarnConnection(kind, pc.connectionState, peer);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (kind === 'main' && peer.role === 'host' && !isHost) setRemoteState('Reconnecting');
        tryIceRestart(peerId, kind, 'connection-state');
      }
    };
    pc.oniceconnectionstatechange = function () {
      maybeWarnConnection(kind, pc.iceConnectionState, peer);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        tryIceRestart(peerId, kind, 'ice-state');
      }
    };

    pc.ontrack = function (event) {
      if (kind === 'main') {
        event.streams[0].getAudioTracks().forEach(function (track) {
          if (!peer.incomingAudio.getTracks().find(function (t) { return t.id === track.id; })) peer.incomingAudio.addTrack(track);
          track.onunmute = function () { attachIncomingAudio(peerId); resumeAudioPlayback(); };
          track.onmute = function () { attachIncomingAudio(peerId); };
          track.onended = function () { attachIncomingAudio(peerId); };
        });
        attachIncomingAudio(peerId);
        resumeAudioPlayback();

        if (peer.role === 'host' && !isHost) {
          event.streams[0].getVideoTracks().forEach(function (track) {
            remoteScreenStream = new MediaStream([track]);
            if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
            setRemoteState('Live');
            safePlay(els.remoteVideo);
            scheduleRemoteVideoHealthCheck('ontrack');
          });
        }
      }
    };

    if (kind === 'main') {
      var outgoingAudio = getOutgoingAudioTrack();
      if (outgoingAudio) {
        peer.senders.mainAudio = pc.addTrack(outgoingAudio, mixedAudioDestination ? mixedAudioDestination.stream : new MediaStream([outgoingAudio]));
        tuneSenderParameters(peer.senders.mainAudio, 'audio');
      } else {
        var silentTrack = createSilentAudioTrack();
        if (silentTrack) peer.senders.mainAudio = pc.addTrack(silentTrack, new MediaStream([silentTrack]));
      }
      if (isHostRelation(peer) && isHost && screenStream && screenStream.getVideoTracks().length) {
        peer.senders.mainVideo = pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
        tuneSenderParameters(peer.senders.mainVideo, 'screenVideo');
      }
    }

    return pc;
  }

  async function negotiate(peerId, kind) {
    var peer = ensurePeerRecord(peerId);
    var pc = createPc(peerId, kind);
    if (!pc || pc.signalingState === 'closed') return;
    try {
      peer.makingOffer[kind] = true;
      var offer = maybePreferVideoCodec(await pc.createOffer());
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
          await pc.setLocalDescription(maybePreferVideoCodec(await pc.createAnswer()));
          sendSignal(from, { kind: kind, description: pc.localDescription });
        }
      } catch (e) {
        setStatus('Signal sync retrying for ' + getPeerLabel(from) + '. Trying again.');
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
      await tuneSenderParameters(peer.senders.mainAudio, 'audio');
    } else if (outgoingAudio) {
      peer.senders.mainAudio = mainPc.addTrack(outgoingAudio, mixedAudioDestination ? mixedAudioDestination.stream : new MediaStream([outgoingAudio]));
      await tuneSenderParameters(peer.senders.mainAudio, 'audio');
    }

    if (isHost && peer.role === 'viewer') {
      var outgoingScreenStream = getOutgoingScreenStream();
      var screenTrack = getOutgoingScreenTrack();
      if (peer.senders.mainVideo) {
        try { await peer.senders.mainVideo.replaceTrack(screenTrack || null); } catch (e) {}
        await tuneSenderParameters(peer.senders.mainVideo, 'screenVideo');
      } else if (screenTrack) {
        peer.senders.mainVideo = mainPc.addTrack(screenTrack, outgoingScreenStream || new MediaStream([screenTrack]));
        await tuneSenderParameters(peer.senders.mainVideo, 'screenVideo');
      }
      if (!screenTrack && peer.senders.mainVideo) { try { await peer.senders.mainVideo.replaceTrack(null); } catch (e) {} }

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
        socket.emit('request-media-sync', { roomId: roomId, targetId: socket.id, reason: reason || 'retry', preferCodec: forceH264Mode ? 'H264' : 'default' });
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
      updateNetworkHint();
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
      setChatMessages(payload.chat || []);
      if (isHost) {
        hostId = socket.id;
        updateHostIdentity(String(els.nameInput && els.nameInput.value || 'Host'));
        if (els.screenTitle) els.screenTitle.textContent = 'Your shared screen';
        setRemoteState(payload.mediaState && payload.mediaState.screenActive ? 'Live' : 'Not sharing');
      } else {
        if (els.screenTitle) els.screenTitle.textContent = 'Shared screen';
        setRemoteState(payload.mediaState && payload.mediaState.screenActive ? 'Receiving' : 'Waiting');
      }
      (payload.peers || []).forEach(function (peerMeta) {
        ensurePeerRecord(peerMeta.id, { role: peerMeta.role, displayName: peerMeta.displayName, browser: peerMeta.browser || null });
      });
      updateButtons();
      updateNetworkHint();
      setupRemoteMediaBindings();
      for (var i = 0; i < (payload.peers || []).length; i++) {
        var peerMeta = payload.peers[i];
        await refreshPeerTracks(peerMeta.id);
        if (shouldInitiateMain(peerMeta.id)) await negotiate(peerMeta.id, 'main');
      }
      if (!isHost && payload.mediaState && payload.mediaState.screenActive && payload.mediaState.hostId) {
        scheduleMediaSyncRequest('join-room');
      }
    });
    socket.on('peer-joined', async function (payload) {
      setCount(payload.count || 0);
      ensurePeerRecord(payload.socketId, { role: payload.role, displayName: payload.displayName, browser: payload.browser || null });
      upsertParticipant({ id: payload.socketId, role: payload.role, displayName: payload.displayName, browser: payload.browser || null });
      if (payload.role === 'host') {
        hostId = payload.socketId;
        updateHostIdentity(payload.displayName);
      }
      await refreshPeerTracks(payload.socketId);
      if (shouldInitiateMain(payload.socketId)) await negotiate(payload.socketId, 'main');
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
        if (payload.mediaState.hostId) hostId = payload.mediaState.hostId;
        if (payload.mediaState.screenActive) { scheduleMediaSyncRequest('room-state'); scheduleRemoteVideoHealthCheck('room-state'); }
        if (!payload.mediaState.screenActive) {
          remoteScreenStream = new MediaStream();
          if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
        }
      }
    });
    socket.on('sync-media-request', async function (payload) {
      if (!isHost || !payload || !payload.targetId) return;
      if (payload.preferCodec === 'H264') forceH264Mode = true;
      await refreshPeerTracks(payload.targetId);
      await negotiate(payload.targetId, 'main');
    });
    socket.on('chat-message', function (message) { pushChatMessage(message); });
    socket.on('media-state', function (payload) {
      var peer = ensurePeerRecord(payload.from);
      if (peer.role === 'host' && !isHost) {
        if (payload.screenActive) {
          setRemoteState('Receiving');
          hostId = payload.from;
          scheduleMediaSyncRequest('media-state');
          scheduleRemoteVideoHealthCheck('media-state');
        } else {
          remoteScreenStream = new MediaStream();
          if (els.remoteVideo) els.remoteVideo.srcObject = remoteScreenStream;
          setRemoteState('Waiting');
        }
      }
    });
    socket.on('disconnect', function () {
      if (inRoom) {
        cleanupRoomState(false);
        setStatus('Disconnected from room.');
      }
      participants = [];
      renderParticipants();
      updateNetworkHint();
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
      socket.emit('join-room', { roomId: nextRoomId, displayName: displayName, requestedRole: requestedRole, password: password, browser: browserMeta });
      socket.emit('get-room-list');
    } else {
      socket.once('connect', function () {
        socket.emit('join-room', { roomId: nextRoomId, displayName: displayName, requestedRole: requestedRole, password: password, browser: browserMeta });
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
      resumeAudioPlayback();
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
    cleanupScreenRelay();
      return;
    }
    try {
      var constraints = { video: { frameRate: 20, width: { max: browserMeta.mobile ? 960 : 1280 }, height: { max: browserMeta.mobile ? 540 : 720 } }, audio: true };
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
      if (shouldUseScreenRelay()) {
        try { await buildScreenRelayStream(); } catch (e) { cleanupScreenRelay(); outboundScreenStream = screenStream; }
      } else {
        outboundScreenStream = screenStream;
      }
      rebuildOutgoingAudioTrack();
      refreshAllPeerTracks();
      peers.forEach(function (peer, peerId) { if (peer.role === 'viewer') negotiate(peerId, 'main'); });
      setRemoteState('Live');
      updateButtons();
      if (socket) socket.emit('media-state', { roomId: roomId, screenActive: true });
      updateNetworkHint();
      setStatus((screenStream.getAudioTracks().length ? 'Screen share started with screen audio.' : 'Screen share started. Browser did not provide screen audio.') + (usingScreenRelay ? ' Compatibility relay mode is on for this host.' : ''));
    } catch (e) {
      setStatus('Screen share was cancelled or blocked.');
    }
  }

  function stopScreenShare() {
    cleanupScreenRelay();
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    }
    screenStream = null;
    outboundScreenStream = null;
    isSharing = false;
    rebuildOutgoingAudioTrack();
    refreshAllPeerTracks();
    if (els.remoteVideo) {
      els.remoteVideo.srcObject = isHost ? new MediaStream() : remoteScreenStream;
      if (!isHost) safePlay(els.remoteVideo);
    }
    setRemoteState(isHost ? 'Not sharing' : 'Waiting');
    updateButtons();
    if (socket) socket.emit('media-state', { roomId: roomId, screenActive: false });
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
    viewerFullscreen = false;
    if (mediaSyncTimer) { clearTimeout(mediaSyncTimer); mediaSyncTimer = null; }
    viewerSideHidden = false;
    chatMessages = [];
    renderChat();
    clearRemoteDisplay();
    stopScreenShare();
    cleanupScreenRelay();
    stopLocalAudio();
    updateButtons();
    updateNetworkHint();
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
  if (els.refreshRoomsBtn) els.refreshRoomsBtn.onclick = function () { ensureSocket(); if (socket) socket.emit('get-room-list'); };
  if (els.sendChatBtn) els.sendChatBtn.onclick = sendChat;
  if (els.resumeAudioBtn) els.resumeAudioBtn.onclick = resumeAudioPlayback;
  if (els.chatInput) els.chatInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  if (els.viewerFullscreenBtn) els.viewerFullscreenBtn.onclick = toggleViewerFullscreen;

  ['click','touchstart'].forEach(function (evt) { document.addEventListener(evt, function () { if (inRoom) resumeAudioPlayback(); }, { passive: true }); });

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
  renderChat();
  updateNetworkHint();
  setStatus('Not connected.');
})();