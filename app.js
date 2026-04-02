(function(){
  var socket=null, inRoom=false, remoteSocketId=null, localAudioStream=null, screenStream=null, camStream=null, joinedRole='viewer', isHost=false, isMicOn=false, isSharing=false, isCamOn=false;
  var pcMain=null, pcCam=null;
  var remoteScreenStream=new MediaStream(), remoteCamStream=new MediaStream();
  var mainSenders={audio:null,video:null}, camSenders={video:null};
  var pendingIce={main:[],cam:[]}, makingOffer={main:false,cam:false}, negotiationTimer={main:null,cam:null};
  var mixedAudioContext=null, mixedAudioDestination=null, mixedMicSource=null, mixedScreenSource=null, mixedOutgoingTrack=null;
  var remotePeerAudioEl=null, remotePeerAudioStream=null, currentHostName='Host';

  var els={
    nameInput:document.getElementById('nameInput'), roomInput:document.getElementById('roomInput'), passwordInput:document.getElementById('passwordInput'), deviceMode:document.getElementById('deviceMode'),
    generateRoomBtn:document.getElementById('generateRoomBtn'), copyRoomBtn:document.getElementById('copyRoomBtn'), joinBtn:document.getElementById('joinBtn'),
    shareBtn:document.getElementById('shareBtn'), micBtn:document.getElementById('micBtn'), camBtn:document.getElementById('camBtn'), leaveBtn:document.getElementById('leaveBtn'),
    remoteVideo:document.getElementById('remoteVideo'), camVideo:document.getElementById('camVideo'), camVideoPanel:document.getElementById('camVideoPanel'), remoteAudio:document.getElementById('remoteAudio'),
    status:document.getElementById('status'), remoteState:document.getElementById('remoteState'), camState:document.getElementById('camState'), camStatePanel:document.getElementById('camStatePanel'),
    countValue:document.getElementById('countValue'), roleValue:document.getElementById('roleValue'), roomsContainer:document.getElementById('roomsContainer'), refreshRoomsBtn:document.getElementById('refreshRoomsBtn'),
    screenTitle:document.getElementById('screenTitle'), camTitle:document.getElementById('camTitle'), fullscreenBtn:document.getElementById('fullscreenBtn'), fullscreenBtnBottom:document.getElementById('fullscreenBtnBottom'),
    avatarFallback:document.getElementById('avatarFallback'), avatarInitials:document.getElementById('avatarInitials'), avatarName:document.getElementById('avatarName'), floatingCam:document.getElementById('floatingCam')
  };

  function setStatus(msg){ els.status.textContent=msg; }
  function setCount(v){ els.countValue.textContent=String(v||0); }
  function setRole(v){ els.roleValue.textContent=v; }
  function sanitizeRoomId(value){ return String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6); }
  function shortCode(){ return Math.random().toString(36).replace(/[^a-z0-9]/gi,'').toUpperCase().slice(2,8); }
  function stopTracks(stream){ if(!stream) return; try{ stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){} }
  function safePlay(media){ if(!media) return; try{ var p=media.play(); if(p && typeof p.catch==='function') p.catch(function(){}); }catch(e){} }
  function getInitials(name){ var parts=String(name||'Host').trim().split(/\s+/).filter(Boolean).slice(0,2); return parts.map(function(v){ return v.charAt(0).toUpperCase(); }).join('') || 'H'; }
  function setHostIdentity(name){ currentHostName=String(name||'Host').trim()||'Host'; els.avatarName.textContent=currentHostName; els.avatarInitials.textContent=getInitials(currentHostName); }
  function setAvatarVisible(show){ els.avatarFallback.style.display=show ? 'flex' : 'none'; }
  function setFloatingCamVisible(show){ els.floatingCam.style.display = show ? 'block' : 'none'; }
  function updateLayoutClasses(){
    document.body.classList.toggle('viewer-mode', !isHost);
  }
  function updateFullscreenButtons(){
    var active=!!document.fullscreenElement;
    if(els.fullscreenBtn) els.fullscreenBtn.textContent=active?'Exit fullscreen':'Fullscreen';
    if(els.fullscreenBtnBottom) els.fullscreenBtnBottom.textContent=active?'Exit fullscreen':'Fullscreen';
  }
  async function toggleFullscreen(){
    try{
      if(document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    }catch(e){}
    updateFullscreenButtons();
  }

  function ensureMixContext(){
    if(typeof window.AudioContext==='undefined' && typeof window.webkitAudioContext==='undefined') return null;
    if(!mixedAudioContext){
      var Ctx = window.AudioContext || window.webkitAudioContext;
      mixedAudioContext = new Ctx();
      mixedAudioDestination = mixedAudioContext.createMediaStreamDestination();
    }
    try{ if(mixedAudioContext.state==='suspended') mixedAudioContext.resume(); }catch(e){}
    return mixedAudioContext;
  }
  function disposeMixedSources(){
    [mixedMicSource,mixedScreenSource].forEach(function(src){ try{ src && src.disconnect(); }catch(e){} });
    mixedMicSource=null; mixedScreenSource=null; mixedOutgoingTrack=null;
  }
  function refreshMixedAudioTrack(){
    if(!isHost){ mixedOutgoingTrack = localAudioStream && localAudioStream.getAudioTracks()[0] || null; return mixedOutgoingTrack; }
    var ctx = ensureMixContext();
    disposeMixedSources();
    if(!ctx || !mixedAudioDestination){ mixedOutgoingTrack = localAudioStream && localAudioStream.getAudioTracks()[0] || null; return mixedOutgoingTrack; }
    var connected=false;
    if(localAudioStream && localAudioStream.getAudioTracks().length){ try{ mixedMicSource=ctx.createMediaStreamSource(localAudioStream); mixedMicSource.connect(mixedAudioDestination); connected=true; }catch(e){} }
    if(screenStream && screenStream.getAudioTracks().length){
      try{ var s = new MediaStream(); screenStream.getAudioTracks().forEach(function(t){ s.addTrack(t); }); mixedScreenSource=ctx.createMediaStreamSource(s); mixedScreenSource.connect(mixedAudioDestination); connected=true; }catch(e){}
    }
    mixedOutgoingTrack = connected ? (mixedAudioDestination.stream.getAudioTracks()[0] || null) : (localAudioStream && localAudioStream.getAudioTracks()[0] || null);
    return mixedOutgoingTrack;
  }

  function ensureHostAudioElement(){
    if(remotePeerAudioEl) return remotePeerAudioEl;
    remotePeerAudioEl=document.createElement('audio');
    remotePeerAudioEl.autoplay=true; remotePeerAudioEl.playsInline=true; remotePeerAudioEl.muted=false; remotePeerAudioEl.controls=false; remotePeerAudioEl.style.display='none';
    document.body.appendChild(remotePeerAudioEl);
    return remotePeerAudioEl;
  }
  function attachRemotePeerAudio(stream, stateText){
    if(!isHost) return;
    var target = ensureHostAudioElement();
    remotePeerAudioStream = stream || remotePeerAudioStream || new MediaStream();
    target.srcObject = remotePeerAudioStream;
    target.volume = 1;
    target.muted = false;
    if(typeof target.load==='function'){ try{ target.load(); }catch(e){} }
    safePlay(target);
    if(stateText) els.remoteState.textContent = stateText;
  }

  function attachScreenStream(stream, stateText){
    els.remoteVideo.srcObject = stream || new MediaStream();
    els.remoteVideo.muted = !!isHost;
    els.remoteState.textContent = stateText || 'Connected';
    safePlay(els.remoteVideo);
    if(!isHost){
      var noCam = !(remoteCamStream && remoteCamStream.getVideoTracks().length);
      setAvatarVisible(noCam);
    } else {
      setAvatarVisible(false);
    }
  }
  function attachCamStream(stream, stateText){
    var src = stream || new MediaStream();
    els.camVideo.srcObject = src;
    els.camVideoPanel.srcObject = src;
    els.camState.textContent = stateText || 'Connected';
    els.camStatePanel.textContent = stateText || 'Connected';
    safePlay(els.camVideo); safePlay(els.camVideoPanel);
    var show = !!(src && src.getVideoTracks && src.getVideoTracks().length);
    if(isHost){ setFloatingCamVisible(false); setAvatarVisible(false); }
    else { setFloatingCamVisible(show); setAvatarVisible(!show); }
  }
  function clearRemoteView(){
    remoteScreenStream = new MediaStream(); remoteCamStream = new MediaStream(); remotePeerAudioStream = new MediaStream();
    attachScreenStream(new MediaStream(),'Waiting');
    attachCamStream(new MediaStream(),'Off');
    if(els.remoteAudio){ els.remoteAudio.srcObject = new MediaStream(); }
    if(remotePeerAudioEl) remotePeerAudioEl.srcObject = new MediaStream();
    setAvatarVisible(!isHost); setFloatingCamVisible(false);
  }

  function updateUiState(){
    updateLayoutClasses(); updateFullscreenButtons();
    els.joinBtn.disabled=inRoom; els.generateRoomBtn.disabled=inRoom; els.copyRoomBtn.disabled=false; els.deviceMode.disabled=inRoom; els.nameInput.disabled=inRoom; els.roomInput.disabled=inRoom; els.passwordInput.disabled=inRoom; els.leaveBtn.disabled=!inRoom;
    els.shareBtn.disabled=!inRoom || !isHost; els.micBtn.disabled=!inRoom; els.camBtn.disabled=!inRoom || !isHost;
    els.shareBtn.textContent=isSharing?'Stop screen share':'Start screen share';
    els.micBtn.textContent=isMicOn?'Mic off':'Mic on';
    els.camBtn.textContent=isCamOn?'Stop camera':'Start camera';
  }

  function ensureSocket(){
    if(socket) return socket;
    if(typeof io==='undefined'){ setStatus('Socket.IO client failed to load.'); return null; }
    socket=io();
    socket.on('connect', function(){ socket.emit('get-room-list'); });
    socket.on('room-list', function(payload){
      var rooms=(payload&&payload.rooms)||[];
      if(!rooms.length){ els.roomsContainer.textContent='No active rooms yet.'; return; }
      els.roomsContainer.innerHTML='';
      rooms.forEach(function(room){
        var row=document.createElement('div'); row.className='room-item';
        var left=document.createElement('div');
        left.innerHTML='<div class="room-code">'+room.roomId+'</div><div class="room-meta">'+room.count+' in room · '+(room.hasHost?'host online':'waiting for host')+' · '+(room.locked?'password':'open')+'</div>';
        var btn=document.createElement('button'); btn.className='secondary'; btn.textContent='Join';
        btn.onclick=function(){ if(inRoom) return; els.roomInput.value=room.roomId; setStatus('Selected room '+room.roomId+'. Enter password if needed, then join.'); };
        row.appendChild(left); row.appendChild(btn); els.roomsContainer.appendChild(row);
      });
    });
    socket.on('room-error',function(message){ setStatus(message||'Room error.'); resetAll(); ensureSocket(); });
    socket.on('room-full',function(){ setStatus('Room is full.'); resetAll(); ensureSocket(); });
    socket.on('joined-room',function(payload){
      isHost=!!(payload&&payload.isHost); joinedRole=isHost?'host':'viewer'; setRole(isHost?'Host':'Viewer'); setCount(payload&&payload.count||0); updateUiState();
      if(isHost){ setStatus('Joined as host. Waiting for viewer...'); setHostIdentity(els.nameInput.value||'Host'); }
      else { setStatus('Joined as viewer. Waiting for host media...'); }
      remoteSocketId=null; ensurePeers(); syncLocalTracks();
      var peers=(payload&&payload.peers)||[];
      peers.forEach(function(peer){ remoteSocketId=peer.id; if(peer.role==='host') setHostIdentity(peer.displayName||'Host'); });
      if(isHost && remoteSocketId){ setStatus('Viewer joined. Sending media...'); queueNegotiation('main',0); queueNegotiation('cam',40); }
    });
    socket.on('peer-count',function(payload){ setCount(payload&&payload.count||0); });
    socket.on('peer-joined',function(payload){
      remoteSocketId=payload.socketId || remoteSocketId;
      if(payload.role==='host') setHostIdentity(payload.displayName||'Host');
      if(payload.role==='viewer' && isHost){ setStatus('Viewer joined. Sending media...'); queueNegotiation('main',0); queueNegotiation('cam',40); }
      if(payload.role==='host' && !isHost){ setStatus('Host joined. Waiting for stream...'); }
      setCount(payload&&payload.count||parseInt(els.countValue.textContent,10)||1);
    });
    socket.on('peer-left',function(payload){ setCount(payload&&payload.count||0); cleanupRemote(); setStatus('Peer left room.'); if(!isHost){ setAvatarVisible(true); setFloatingCamVisible(false); } });
    socket.on('media-state',function(payload){
      if(!payload) return;
      if(payload.screenActive===false && !isHost){ attachScreenStream(new MediaStream(),'Waiting'); }
      if(payload.camActive===false && !isHost){ attachCamStream(new MediaStream(),'Off'); }
      if(!isHost){
        if(payload.camActive){ setAvatarVisible(false); }
        else { setAvatarVisible(true); setFloatingCamVisible(false); }
      }
    });
    socket.on('signal', handleSignal);
    socket.on('disconnect',function(){ if(inRoom) setStatus('Disconnected. Rejoin the room.'); });
    return socket;
  }

  function createPeer(kind){
    var cfg=(window.WATCH_ROOM_CONFIG&&window.WATCH_ROOM_CONFIG.iceServers)?window.WATCH_ROOM_CONFIG:{};
    var pc=new RTCPeerConnection(cfg);
    pc.onicecandidate=function(e){ if(e.candidate && socket && remoteSocketId){ socket.emit('signal',{to:remoteSocketId,data:{pc:kind,type:'candidate',candidate:e.candidate}}); } };
    pc.onconnectionstatechange=function(){
      var state=pc.connectionState;
      if(kind==='main'){
        if(state==='connected') els.remoteState.textContent=isHost?(isSharing?'Preview':'Connected'):(isSharing?'Receiving':'Connected');
        else if(state==='connecting') els.remoteState.textContent='Connecting';
        else if(state==='failed') els.remoteState.textContent='Reconnect needed';
      } else {
        if(state==='connected'){ els.camState.textContent=isHost?(isCamOn?'Preview':'Off'):(isCamOn?'Connected':els.camState.textContent); els.camStatePanel.textContent=els.camState.textContent; }
        else if(state==='connecting'){ els.camState.textContent='Connecting'; els.camStatePanel.textContent='Connecting'; }
        else if(state==='failed'){ els.camState.textContent='Reconnect needed'; els.camStatePanel.textContent='Reconnect needed'; }
      }
    };
    pc.ontrack=function(event){
      var stream = (event.streams && event.streams[0]) || null;
      if(kind==='main'){
        if(event.track.kind==='audio'){
          var audioStream = stream || new MediaStream([event.track]);
          if(isHost){ attachRemotePeerAudio(audioStream,'Connected'); }
          else {
            els.remoteAudio.srcObject = audioStream;
            els.remoteAudio.muted = false;
            els.remoteAudio.volume = 1;
            safePlay(els.remoteAudio);
          }
          event.track.onunmute=function(){
            if(isHost) attachRemotePeerAudio(audioStream,'Connected');
            else { els.remoteAudio.srcObject = audioStream; safePlay(els.remoteAudio); }
          };
        } else {
          if(stream){ stream.getVideoTracks().forEach(function(track){ if(!remoteScreenStream.getTracks().some(function(t){ return t.id===track.id; })) remoteScreenStream.addTrack(track); }); }
          else if(event.track && !remoteScreenStream.getTracks().some(function(t){ return t.id===event.track.id; })){ remoteScreenStream.addTrack(event.track); }
          attachScreenStream(remoteScreenStream,'Receiving');
        }
      } else {
        if(stream){ stream.getVideoTracks().forEach(function(track){ if(!remoteCamStream.getTracks().some(function(t){ return t.id===track.id; })) remoteCamStream.addTrack(track); }); }
        else if(event.track && !remoteCamStream.getTracks().some(function(t){ return t.id===event.track.id; })){ remoteCamStream.addTrack(event.track); }
        attachCamStream(remoteCamStream,'Receiving');
      }
    };
    if(kind==='main'){
      mainSenders.audio=pc.addTransceiver('audio',{direction:'sendrecv'}).sender;
      mainSenders.video=pc.addTransceiver('video',{direction:'sendrecv'}).sender;
    } else {
      camSenders.video=pc.addTransceiver('video',{direction:'sendrecv'}).sender;
    }
    return pc;
  }
  function ensurePeers(){ if(!pcMain) pcMain=createPeer('main'); if(!pcCam) pcCam=createPeer('cam'); }
  function getPc(kind){ return kind==='main' ? pcMain : pcCam; }
  function syncLocalTracks(){
    ensurePeers();
    var outgoingAudio = refreshMixedAudioTrack();
    try{ mainSenders.audio && mainSenders.audio.replaceTrack(outgoingAudio || null); }catch(e){}
    try{ mainSenders.video && mainSenders.video.replaceTrack(screenStream && screenStream.getVideoTracks()[0] || null); }catch(e){}
    try{ camSenders.video && camSenders.video.replaceTrack(camStream && camStream.getVideoTracks()[0] || null); }catch(e){}
  }
  function queueNegotiation(kind, delay){
    if(!isHost || !remoteSocketId) return;
    if(negotiationTimer[kind]) clearTimeout(negotiationTimer[kind]);
    negotiationTimer[kind]=setTimeout(function(){ negotiate(kind); }, typeof delay==='number' ? delay : 80);
  }
  async function negotiate(kind){
    var pc=getPc(kind);
    if(!isHost || !pc || !remoteSocketId || makingOffer[kind]) return;
    if(pc.signalingState!=='stable') return;
    try{
      makingOffer[kind]=true;
      var offer=await pc.createOffer();
      if(pc.signalingState!=='stable') return;
      await pc.setLocalDescription(offer);
      socket.emit('signal',{to:remoteSocketId,data:{pc:kind,type:'offer',offer:pc.localDescription}});
    }catch(err){ setStatus('Offer error ('+kind+'): '+((err&&err.message)?err.message:String(err))); }
    finally{ makingOffer[kind]=false; }
  }
  async function flushPendingCandidates(kind){
    var pc=getPc(kind), list=pendingIce[kind]||[];
    if(!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
    while(list.length){ try{ await pc.addIceCandidate(new RTCIceCandidate(list.shift())); }catch(e){} }
  }
  async function handleSignal(message){
    try{
      remoteSocketId=message.from;
      var data=message.data||{};
      var kind=data.pc==='cam'?'cam':'main';
      ensurePeers();
      var pc=getPc(kind);
      if(data.type==='offer' && data.offer){
        if(isHost) return;
        if(pc.signalingState!=='stable'){
          try{ pc.close(); }catch(e){}
          if(kind==='main'){ pcMain=createPeer('main'); pc=pcMain; } else { pcCam=createPeer('cam'); pc=pcCam; }
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await flushPendingCandidates(kind);
        var answer=await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal',{to:remoteSocketId,data:{pc:kind,type:'answer',answer:pc.localDescription}});
      } else if(data.type==='answer' && data.answer){
        if(!isHost || pc.signalingState!=='have-local-offer') return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await flushPendingCandidates(kind);
      } else if(data.type==='candidate' && data.candidate){
        if(pc.remoteDescription && pc.remoteDescription.type){ try{ await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }catch(err){} }
        else { pendingIce[kind].push(data.candidate); }
      }
    }catch(err){ setStatus('Signal error: '+((err&&err.message)?err.message:String(err))); }
  }

  function emitMediaState(){ if(socket && inRoom) socket.emit('media-state',{roomId:els.roomInput.value,screenActive:isSharing,camActive:isCamOn}); }
  async function getMicStream(){ return await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false}); }
  async function getCamStream(){ return await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:360},frameRate:{ideal:20,max:24}}}); }

  async function startScreenShare(){
    try{
      if(!isHost){ setStatus('Only the host can share the screen.'); return; }
      if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){ setStatus('Screen share is not supported in this browser.'); return; }
      screenStream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:20,max:24}},audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},systemAudio:'include',selfBrowserSurface:'exclude',surfaceSwitching:'include'});
      var v=screenStream.getVideoTracks()[0];
      if(v){ try{ v.contentHint='detail'; }catch(e){} v.onended=function(){ stopScreenShare(); }; }
      isSharing=true; syncLocalTracks(); attachScreenStream(screenStream,'Preview'); emitMediaState(); updateUiState(); queueNegotiation('main',0);
      setStatus(screenStream.getAudioTracks().length ? 'Screen sharing started with screen audio.' : 'Screen sharing started. This browser did not provide screen audio, so only mic audio is being sent.');
    }catch(err){ setStatus('Screen share failed: '+((err&&err.message)?err.message:String(err))); }
  }
  async function stopScreenShare(){
    stopTracks(screenStream); screenStream=null; isSharing=false; syncLocalTracks(); attachScreenStream(new MediaStream(),'Waiting'); emitMediaState(); updateUiState(); queueNegotiation('main',0); setStatus('Screen sharing stopped.');
  }
  async function toggleScreenShare(){ if(!inRoom) return; if(isSharing) await stopScreenShare(); else await startScreenShare(); }
  async function toggleMic(){
    if(!inRoom) return;
    if(isMicOn){ stopTracks(localAudioStream); localAudioStream=null; isMicOn=false; syncLocalTracks(); queueNegotiation('main',0); updateUiState(); setStatus('Microphone disabled.'); return; }
    try{ localAudioStream=await getMicStream(); isMicOn=true; syncLocalTracks(); queueNegotiation('main',0); updateUiState(); setStatus('Microphone enabled.'); }
    catch(err){ setStatus('Mic failed: '+((err&&err.message)?err.message:String(err))); }
  }
  async function toggleCam(){
    if(!inRoom) return;
    if(!isHost){ setStatus('Viewer mode has camera disabled.'); return; }
    if(isCamOn){ stopTracks(camStream); camStream=null; isCamOn=false; syncLocalTracks(); attachCamStream(new MediaStream(),'Off'); emitMediaState(); updateUiState(); queueNegotiation('cam',0); setStatus('Camera stopped.'); return; }
    try{ camStream=await getCamStream(); var track=camStream.getVideoTracks()[0]; if(track){ try{ track.contentHint='motion'; }catch(e){} } isCamOn=true; syncLocalTracks(); attachCamStream(camStream,'Preview'); emitMediaState(); updateUiState(); queueNegotiation('cam',0); setStatus('Camera started.'); }
    catch(err){ setStatus('Camera failed: '+((err&&err.message)?err.message:String(err))); }
  }

  function cleanupRemote(){
    if(negotiationTimer.main) clearTimeout(negotiationTimer.main); if(negotiationTimer.cam) clearTimeout(negotiationTimer.cam);
    if(pcMain){ try{pcMain.close();}catch(e){} pcMain=null; }
    if(pcCam){ try{pcCam.close();}catch(e){} pcCam=null; }
    mainSenders={audio:null,video:null}; camSenders={video:null}; remoteSocketId=null; pendingIce={main:[],cam:[]}; makingOffer={main:false,cam:false};
    clearRemoteView();
  }
  function resetAll(){
    cleanupRemote(); if(socket){ try{socket.disconnect();}catch(e){} socket=null; }
    stopTracks(localAudioStream); stopTracks(screenStream); stopTracks(camStream);
    localAudioStream=null; screenStream=null; camStream=null; inRoom=false; joinedRole='viewer'; isHost=false; isMicOn=false; isSharing=false; isCamOn=false;
    disposeMixedSources(); if(mixedAudioContext){ try{ mixedAudioContext.close(); }catch(e){} } mixedAudioContext=null; mixedAudioDestination=null; mixedOutgoingTrack=null;
    setRole('Viewer'); setCount(0); updateUiState(); clearRemoteView();
  }
  async function joinRoom(){
    if(inRoom) return;
    var roomId=sanitizeRoomId(els.roomInput.value), displayName=els.nameInput.value.trim()||'Guest', password=els.passwordInput.value; joinedRole=els.deviceMode.value||'viewer';
    if(!roomId){ setStatus('Enter a room code first.'); return; }
    els.roomInput.value=roomId; setHostIdentity(displayName);
    if(!ensureSocket()) return;
    try{
      setStatus('Opening required microphone...');
      localAudioStream=await getMicStream(); isMicOn=true; inRoom=true; isHost=joinedRole==='host'; setRole(isHost?'Host':'Viewer'); updateUiState();
      els.remoteVideo.muted=isHost; syncLocalTracks();
      socket.emit('join-room',{roomId:roomId,displayName:displayName,requestedRole:joinedRole,password:password});
    }catch(err){ setStatus('Mic failed: '+((err&&err.message)?err.message:String(err))); resetAll(); }
  }
  function leaveRoom(){ resetAll(); setStatus('Left room.'); ensureSocket(); }
  function copyRoom(){ var text=els.roomInput.value.trim(); if(!text){ setStatus('Nothing to copy yet.'); return; } navigator.clipboard.writeText(text).then(function(){ setStatus('Room code copied.'); }).catch(function(){ setStatus('Copy failed. Copy manually.'); }); }

  els.generateRoomBtn.addEventListener('click',function(){ if(inRoom) return; els.roomInput.value=shortCode(); setStatus('Short room code generated.'); });
  els.copyRoomBtn.addEventListener('click',copyRoom); els.joinBtn.addEventListener('click',joinRoom); els.shareBtn.addEventListener('click',toggleScreenShare); els.micBtn.addEventListener('click',toggleMic); els.camBtn.addEventListener('click',toggleCam); els.leaveBtn.addEventListener('click',leaveRoom);
  els.refreshRoomsBtn.addEventListener('click',function(){ ensureSocket() && socket.emit('get-room-list'); });
  els.fullscreenBtn.addEventListener('click',toggleFullscreen); els.fullscreenBtnBottom.addEventListener('click',toggleFullscreen); document.addEventListener('fullscreenchange', updateFullscreenButtons);

  els.remoteVideo.controls=false; els.camVideo.controls=false; els.camVideoPanel.controls=false; els.remoteVideo.muted=false; els.camVideo.muted=true; els.camVideoPanel.muted=true;
  els.remoteVideo.setAttribute('playsinline',''); els.camVideo.setAttribute('playsinline',''); els.camVideoPanel.setAttribute('playsinline','');
  if(els.remoteAudio){ els.remoteAudio.autoplay=true; els.remoteAudio.setAttribute('playsinline',''); els.remoteAudio.muted=false; }
  els.deviceMode.addEventListener('change', function(){ if(!inRoom){ isHost=els.deviceMode.value==='host'; updateLayoutClasses(); } });
  els.roomInput.value=location.hash&&location.hash.length>1?sanitizeRoomId(decodeURIComponent(location.hash.slice(1))):shortCode();
  isHost=els.deviceMode.value==='host'; setHostIdentity(els.nameInput.value||'Host'); clearRemoteView(); updateUiState(); ensureSocket();
})();
