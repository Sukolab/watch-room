(function(){
  var socket=null, inRoom=false, remoteSocketId=null, localAudioStream=null, screenStream=null, camStream=null, joinedRole='viewer', isHost=false, isMicOn=false, isSharing=false, isCamOn=false, remoteHostName='Host', viewerFullscreen=false, viewerSideHidden=false;
  var pcMain=null, pcCam=null;
  var remoteScreenStream=new MediaStream(), remoteCamStream=new MediaStream(), remotePeerAudioStream=new MediaStream();
  var mainSenders={audio:null,video:null}, camSenders={video:null};
  var pendingIce={main:[],cam:[]}, makingOffer={main:false,cam:false}, needsNegotiation={main:false,cam:false}, negotiationTimer={main:null,cam:null};
  var mixedAudioContext=null, mixedAudioDestination=null, mixedMicSource=null, mixedScreenSource=null, mixedOutgoingTrack=null;
  var els={
    nameInput:document.getElementById('nameInput'),
    roomInput:document.getElementById('roomInput'),
    passwordInput:document.getElementById('passwordInput'),
    deviceMode:document.getElementById('deviceMode'),
    generateRoomBtn:document.getElementById('generateRoomBtn'),
    copyRoomBtn:document.getElementById('copyRoomBtn'),
    joinBtn:document.getElementById('joinBtn'),
    shareBtn:document.getElementById('shareBtn'),
    micBtn:document.getElementById('micBtn'),
    camBtn:document.getElementById('camBtn'),
    leaveBtn:document.getElementById('leaveBtn'),
    remoteVideo:document.getElementById('remoteVideo'),
    camVideo:document.getElementById('camVideo'),
    remoteAudio:document.getElementById('remoteAudio'),
    status:document.getElementById('status'),
    remoteState:document.getElementById('remoteState'),
    camState:document.getElementById('camState'),
    countValue:document.getElementById('countValue'),
    roleValue:document.getElementById('roleValue'),
    roomsContainer:document.getElementById('roomsContainer'),
    refreshRoomsBtn:document.getElementById('refreshRoomsBtn'),
    screenTitle:document.getElementById('screenTitle'),
    camTitle:document.getElementById('camTitle'),
    viewerFullscreenBtn:document.getElementById('viewerFullscreenBtn'),
    toggleSideBtn:document.getElementById('toggleSideBtn'),
    camPlaceholder:document.getElementById('camPlaceholder'),
    hostInitials:document.getElementById('hostInitials'),
    hostDisplayName:document.getElementById('hostDisplayName')
  };


  function nameToInitials(name){
    var parts=String(name||'Host').trim().split(/\s+/).filter(Boolean).slice(0,2);
    if(!parts.length) return 'H';
    return parts.map(function(part){ return part.charAt(0).toUpperCase(); }).join('');
  }
  function updateHostIdentity(name){
    remoteHostName = String(name||remoteHostName||'Host').trim() || 'Host';
    if(els.hostDisplayName) els.hostDisplayName.textContent = remoteHostName;
    if(els.hostInitials) els.hostInitials.textContent = nameToInitials(remoteHostName);
  }
  function updateCamPlaceholder(){
    if(!els.camPlaceholder) return;
    var show = !isHost && !isCamOn;
    els.camPlaceholder.classList.toggle('show', !!show);
    if(els.camVideo) els.camVideo.style.display = show ? 'none' : 'block';
  }
  function syncViewerFullscreenUi(){
    var viewerMode = inRoom && !isHost;
    if(els.viewerFullscreenBtn) els.viewerFullscreenBtn.hidden = !viewerMode;
    if(els.toggleSideBtn) els.toggleSideBtn.hidden = !viewerMode || !viewerFullscreen;
    if(els.viewerFullscreenBtn) els.viewerFullscreenBtn.textContent = viewerFullscreen ? 'Exit fullscreen' : 'Fullscreen';
    if(els.toggleSideBtn) els.toggleSideBtn.textContent = viewerSideHidden ? 'Show cam' : 'Hide cam';
    document.body.classList.toggle('viewer-fullscreen', viewerMode && viewerFullscreen);
    document.body.classList.toggle('side-hidden', viewerMode && viewerFullscreen && viewerSideHidden);
  }
  async function toggleViewerFullscreen(){
    if(isHost || !inRoom) return;
    viewerFullscreen = !viewerFullscreen;
    viewerSideHidden = false;
    syncViewerFullscreenUi();
    var target = document.documentElement;
    try{
      if(viewerFullscreen){
        if(target.requestFullscreen && !document.fullscreenElement) await target.requestFullscreen();
      } else if(document.fullscreenElement && document.exitFullscreen){
        await document.exitFullscreen();
      }
    }catch(e){}
    safePlay(els.remoteVideo);
    safePlay(els.camVideo);
  }
  function toggleViewerSide(){
    if(isHost || !inRoom || !viewerFullscreen) return;
    viewerSideHidden = !viewerSideHidden;
    syncViewerFullscreenUi();
    safePlay(els.remoteVideo);
    safePlay(els.camVideo);
  }

  function shortCode(){ var chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out=''; for(var i=0;i<6;i++) out += chars[Math.floor(Math.random()*chars.length)]; return out; }
  function sanitizeRoomId(value){ return String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6); }
  function setStatus(msg){ els.status.textContent=msg; }
  function setCount(n){ els.countValue.textContent=String(n||0); }
  function setRole(role){ els.roleValue.textContent=role; }
  function stopTracks(stream){ if(!stream) return; stream.getTracks().forEach(function(t){ try{t.stop()}catch(e){} }); }
  function safePlay(media){ if(!media) return Promise.resolve(); try{ var p=media.play(); if(p && typeof p.catch==='function'){ return p.catch(function(){}) } }catch(e){} return Promise.resolve(); }

  function ensureAudioContext(){
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return null;
    if(!mixedAudioContext){
      mixedAudioContext = new Ctx();
      mixedAudioDestination = mixedAudioContext.createMediaStreamDestination();
    }
    try{ if(mixedAudioContext.state === 'suspended') mixedAudioContext.resume(); }catch(e){}
    return mixedAudioContext;
  }
  function disposeMixedSources(){
    [mixedMicSource, mixedScreenSource].forEach(function(src){
      if(!src) return;
      try{ src.disconnect(); }catch(e){}
    });
    mixedMicSource=null;
    mixedScreenSource=null;
    mixedOutgoingTrack=null;
  }
  function refreshMixedAudioTrack(){
    if(!isHost){
      mixedOutgoingTrack = localAudioStream && localAudioStream.getAudioTracks()[0] || null;
      return mixedOutgoingTrack;
    }
    var ctx = ensureAudioContext();
    if(!ctx || !mixedAudioDestination){
      mixedOutgoingTrack = localAudioStream && localAudioStream.getAudioTracks()[0] || null;
      return mixedOutgoingTrack;
    }
    disposeMixedSources();
    var connected=false;
    try{
      if(localAudioStream && localAudioStream.getAudioTracks().length){
        mixedMicSource = ctx.createMediaStreamSource(localAudioStream);
        mixedMicSource.connect(mixedAudioDestination);
        connected=true;
      }
    }catch(e){}
    try{
      if(screenStream && screenStream.getAudioTracks().length){
        var screenAudioOnly = new MediaStream(screenStream.getAudioTracks());
        mixedScreenSource = ctx.createMediaStreamSource(screenAudioOnly);
        mixedScreenSource.connect(mixedAudioDestination);
        connected=true;
      }
    }catch(e){}
    mixedOutgoingTrack = connected ? (mixedAudioDestination.stream.getAudioTracks()[0] || null) : (localAudioStream && localAudioStream.getAudioTracks()[0] || null);
    return mixedOutgoingTrack;
  }

  function attachRemotePeerAudio(stateText){
    if(!els.remoteAudio) return;
    els.remoteAudio.srcObject = remotePeerAudioStream;
    els.remoteAudio.autoplay = true;
    els.remoteAudio.controls = false;
    els.remoteAudio.volume = 1;
    els.remoteAudio.muted = false;
    try{ els.remoteAudio.load(); }catch(e){}
    safePlay(els.remoteAudio);
    if(stateText) els.remoteState.textContent = stateText;
  }
  function attachScreenStream(stream, stateText){
    els.remoteVideo.srcObject=stream||new MediaStream();
    els.remoteVideo.muted=!!isHost;
    els.remoteState.textContent=stateText||'Connected';
    safePlay(els.remoteVideo);
    if(isHost){ attachRemotePeerAudio(stateText || 'Connected'); }
  }
  function attachCamStream(stream, stateText){
    els.camVideo.srcObject=stream||new MediaStream();
    els.camState.textContent=stateText||'Connected';
    safePlay(els.camVideo);
    updateCamPlaceholder();
  }
  function updateTitles(){
    els.screenTitle.textContent=isHost ? 'Your shared screen' : 'Shared screen';
    els.camTitle.textContent=isHost ? 'Your camera' : 'Host camera';
  }
  function updateUiState(){
    els.joinBtn.disabled=inRoom; els.generateRoomBtn.disabled=inRoom; els.copyRoomBtn.disabled=false; els.deviceMode.disabled=inRoom; els.nameInput.disabled=inRoom; els.roomInput.disabled=inRoom; els.passwordInput.disabled=inRoom; els.leaveBtn.disabled=!inRoom;
    els.shareBtn.disabled=!inRoom || !isHost; els.camBtn.disabled=!inRoom || !isHost; els.micBtn.disabled=!inRoom;
    els.shareBtn.textContent=isSharing?'Stop screen share':'Start screen share'; els.micBtn.textContent=isMicOn?'Mic on':'Mic off'; els.camBtn.textContent=isCamOn?'Stop camera':'Start camera';
    updateTitles();
    updateCamPlaceholder();
    syncViewerFullscreenUi();
  }
  function renderRooms(rooms){
    if(!rooms || !rooms.length){ els.roomsContainer.textContent='No active rooms yet.'; return; }
    els.roomsContainer.innerHTML='';
    rooms.forEach(function(room){
      var div=document.createElement('div'); div.className='room-item';
      var left=document.createElement('div');
      left.innerHTML='<div class="room-code">'+room.roomId+'</div><div class="room-meta">'+room.count+' inside · '+(room.hasHost?'host ready':'waiting for host')+(room.locked?' · password':'')+'</div>';
      var btn=document.createElement('button'); btn.className='secondary'; btn.style.padding='9px 12px'; btn.style.fontSize='13px'; btn.textContent='Use';
      btn.onclick=function(){ if(inRoom) return; els.roomInput.value=room.roomId; setStatus('Selected room '+room.roomId+'. Enter password if needed, then join.'); };
      div.appendChild(left); div.appendChild(btn); els.roomsContainer.appendChild(div);
    });
  }
  function clearRemoteView(){
    remoteScreenStream=new MediaStream(); remoteCamStream=new MediaStream(); remotePeerAudioStream=new MediaStream();
    if(els.remoteAudio){ els.remoteAudio.srcObject = remotePeerAudioStream; }
    attachScreenStream(isHost && screenStream ? screenStream : new MediaStream(), isHost && isSharing ? 'Preview' : 'Waiting');
    attachCamStream(isHost && camStream ? camStream : new MediaStream(), isHost && isCamOn ? 'Preview' : 'Off');
  }

  function ensureSocket(){
    if(socket) return true;
    socket=io();
    socket.on('connect',function(){ socket.emit('get-room-list'); });
    socket.on('room-list',function(payload){ renderRooms(payload && payload.rooms ? payload.rooms : []); });
    socket.on('peer-count',function(payload){ setCount(payload && payload.count || 0); });
    socket.on('room-error',function(message){ setStatus(message||'Room error.'); resetAll(); ensureSocket(); });
    socket.on('room-full',function(){ setStatus('Room is full.'); resetAll(); ensureSocket(); });
    socket.on('joined-room',async function(payload){
      isHost=!!payload.isHost; joinedRole=isHost?'host':'viewer'; setRole(isHost?'Host':'Viewer'); setCount(payload.count||1); updateUiState();
      if(isHost){ setStatus('Joined as host. Waiting for viewer...'); } else { setStatus('Joined as viewer. Waiting for host media...'); }
      ensurePeers();
      syncLocalTracks();
      var peers=payload.peers||[];
      var target=peers.find(function(p){ return p.role==='host'; }) || peers[0] || null;
      if(target){
        remoteSocketId=target.id;
        if(target.displayName) updateHostIdentity(target.displayName);
        if(isHost){ forceNegotiate('main'); forceNegotiate('cam'); }
      }
    });
    socket.on('peer-joined',function(payload){
      setCount(payload&&payload.count||0);
      if(!payload || !payload.socketId) return;
      if(payload.role==='host' && payload.displayName){ updateHostIdentity(payload.displayName); }
      if(isHost && payload.role==='viewer'){
        remoteSocketId=payload.socketId;
        ensurePeers();
        syncLocalTracks();
        forceNegotiate('main');
        forceNegotiate('cam');
        setStatus('Viewer joined. Sending media...');
      } else if(!isHost && payload.role==='host'){
        remoteSocketId=payload.socketId;
        ensurePeers();
        setStatus('Host joined. Waiting for stream...');
      }
    });
    socket.on('peer-left',function(payload){ setCount(payload&&payload.count||0); cleanupRemote(); setStatus('Peer left room.'); });
    socket.on('media-state',function(payload){
      if(payload && payload.from && remoteSocketId && payload.from!==remoteSocketId) return;
      if(!isHost){
        els.remoteState.textContent=payload && payload.screenActive ? 'Receiving' : 'Waiting';
        els.camState.textContent=payload && payload.camActive ? 'Receiving' : 'Off';
        isCamOn = !!(payload && payload.camActive);
        updateCamPlaceholder();
      }
    });
    socket.on('signal',handleSignal);
    socket.on('disconnect',function(){ if(inRoom) setStatus('Disconnected. Rejoin the room.'); });
    return true;
  }

  function buildIceServerConfig(){ var configured=(window.WATCH_ROOM_CONFIG&&Array.isArray(window.WATCH_ROOM_CONFIG.iceServers))?window.WATCH_ROOM_CONFIG.iceServers:null; return {iceServers:(configured&&configured.length)?configured:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]}; }
  function createPeer(kind){
    var pc=new RTCPeerConnection(buildIceServerConfig());
    pc.onicecandidate=function(event){
      if(event.candidate && socket && remoteSocketId) socket.emit('signal',{to:remoteSocketId,data:{pc:kind,type:'candidate',candidate:event.candidate}});
    };
    pc.onconnectionstatechange=function(){
      var state=pc.connectionState||'unknown';
      if(kind==='main'){
        if(state==='connected') els.remoteState.textContent=isHost?(isSharing?'Preview':'Ready'):'Connected';
        else if(state==='connecting') els.remoteState.textContent='Connecting';
        else if(state==='failed') els.remoteState.textContent='Reconnect needed';
      } else {
        if(state==='connected') els.camState.textContent=isHost?(isCamOn?'Preview':'Off'):(isCamOn?'Connected':els.camState.textContent);
        else if(state==='connecting') els.camState.textContent='Connecting';
        else if(state==='failed') els.camState.textContent='Reconnect needed';
      }
    };
    pc.onsignalingstatechange=function(){
      if(isHost && pc.signalingState==='stable' && needsNegotiation[kind]){ needsNegotiation[kind]=false; queueNegotiation(kind, 0); }
    };
    pc.ontrack=function(event){
      var stream = event.streams && event.streams[0] ? event.streams[0] : null;
      if(kind==='main'){
        if(event.track && event.track.kind === 'audio' && isHost){
          if(!remotePeerAudioStream.getTracks().some(function(t){return t.id===event.track.id;})) remotePeerAudioStream.addTrack(event.track);
          attachRemotePeerAudio('Connected');
          return;
        }
        if(stream){
          stream.getTracks().forEach(function(track){
            if(track.kind === 'audio' && isHost){
              if(!remotePeerAudioStream.getTracks().some(function(t){return t.id===track.id;})) remotePeerAudioStream.addTrack(track);
            } else if(!remoteScreenStream.getTracks().some(function(t){return t.id===track.id;})) {
              remoteScreenStream.addTrack(track);
            }
          });
        } else if(event.track){
          if(event.track.kind === 'audio' && isHost){
            if(!remotePeerAudioStream.getTracks().some(function(t){return t.id===event.track.id;})) remotePeerAudioStream.addTrack(event.track);
            event.track.onunmute=function(){ attachRemotePeerAudio('Connected'); };
          } else if(!remoteScreenStream.getTracks().some(function(t){return t.id===event.track.id;})){
            remoteScreenStream.addTrack(event.track);
          }
        }
        if(isHost){ attachRemotePeerAudio('Connected'); }
        else { attachScreenStream(remoteScreenStream,'Receiving'); }
      } else {
        if(stream){ stream.getTracks().forEach(function(track){ if(!remoteCamStream.getTracks().some(function(t){return t.id===track.id;})) remoteCamStream.addTrack(track); }); }
        else if(event.track && !remoteCamStream.getTracks().some(function(t){return t.id===event.track.id;})){ remoteCamStream.addTrack(event.track); }
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
  function forceNegotiate(kind){ needsNegotiation[kind]=false; queueNegotiation(kind, 0); }
  async function negotiate(kind){
    var pc=getPc(kind);
    if(!isHost || !pc || !remoteSocketId) return;
    if(makingOffer[kind]) return;
    if(pc.signalingState!=='stable'){ needsNegotiation[kind]=true; return; }
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
    while(list.length){
      try{ await pc.addIceCandidate(new RTCIceCandidate(list.shift())); }catch(e){}
    }
  }
  async function handleSignal(message){
    try{
      remoteSocketId=message.from;
      var data=message.data||{};
      var kind=data.pc==='cam'?'cam':'main';
      ensurePeers();
      var pc=getPc(kind);
      if(data.type==='offer' && data.offer){
        if(isHost){ return; }
        if(pc.signalingState!=='stable'){
          setStatus('Resetting '+kind+' stream negotiation...');
          try{ pc.close(); }catch(e){}
          if(kind==='main'){ pcMain=createPeer('main'); pc=pcMain; } else { pcCam=createPeer('cam'); pc=pcCam; }
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await flushPendingCandidates(kind);
        var answer=await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal',{to:remoteSocketId,data:{pc:kind,type:'answer',answer:pc.localDescription}});
      } else if(data.type==='answer' && data.answer){
        if(!isHost) return;
        if(pc.signalingState!=='have-local-offer') return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await flushPendingCandidates(kind);
      } else if(data.type==='candidate' && data.candidate){
        if(pc.remoteDescription && pc.remoteDescription.type){
          try{ await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }catch(err){}
        } else {
          pendingIce[kind].push(data.candidate);
        }
      }
    }catch(err){ setStatus('Signal error: '+((err&&err.message)?err.message:String(err))); }
  }

  function emitMediaState(){ if(socket && inRoom) socket.emit('media-state',{roomId:els.roomInput.value,screenActive:isSharing,camActive:isCamOn}); }
  async function getMicStream(){
    return await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},
      video:false
    });
  }
  async function getCamStream(){ return await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:360},frameRate:{ideal:20,max:24}}}); }

  async function startScreenShare(){
    try{
      if(!isHost){ setStatus('Only the host can share the screen.'); return; }
      if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){ setStatus('Screen share is not supported in this browser.'); return; }
      screenStream=await navigator.mediaDevices.getDisplayMedia({
        video:{frameRate:{ideal:20,max:24}},
        audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},
        systemAudio:'include',
        selfBrowserSurface:'exclude',
        surfaceSwitching:'include'
      });
      var v=screenStream.getVideoTracks()[0];
      if(v){ try{ v.contentHint='detail'; }catch(e){} v.onended=function(){ stopScreenShare(); }; }
      isSharing=true;
      syncLocalTracks();
      attachScreenStream(screenStream,'Preview');
      emitMediaState();
      updateUiState();
      forceNegotiate('main');
      setStatus(screenStream.getAudioTracks().length ? 'Screen sharing started with screen audio.' : 'Screen sharing started. This browser did not provide screen audio, so only mic audio is being sent.');
    }catch(err){ setStatus('Screen share failed: '+((err&&err.message)?err.message:String(err))); }
  }
  async function stopScreenShare(){
    stopTracks(screenStream); screenStream=null; isSharing=false;
    syncLocalTracks();
    attachScreenStream(isHost?new MediaStream():new MediaStream(),'Waiting');
    emitMediaState();
    updateUiState();
    forceNegotiate('main');
    setStatus('Screen sharing stopped.');
  }
  async function toggleScreenShare(){ if(!inRoom) return; if(isSharing) await stopScreenShare(); else await startScreenShare(); }
  async function toggleMic(){
    if(!inRoom) return;
    if(isMicOn){
      stopTracks(localAudioStream); localAudioStream=null; isMicOn=false;
      syncLocalTracks(); forceNegotiate('main'); updateUiState(); setStatus('Microphone disabled.'); return;
    }
    try{
      localAudioStream=await getMicStream(); isMicOn=true;
      syncLocalTracks(); forceNegotiate('main'); updateUiState(); setStatus('Microphone enabled.');
    } catch(err){ setStatus('Mic failed: '+((err&&err.message)?err.message:String(err))); }
  }
  async function toggleCam(){
    if(!inRoom) return;
    if(!isHost){ setStatus('Viewer mode has camera disabled.'); return; }
    if(isCamOn){ stopTracks(camStream); camStream=null; isCamOn=false; syncLocalTracks(); attachCamStream(new MediaStream(),'Off'); emitMediaState(); updateUiState(); forceNegotiate('cam'); setStatus('Camera stopped.'); return; }
    try{ camStream=await getCamStream(); var track=camStream.getVideoTracks()[0]; if(track){ try{ track.contentHint='motion'; }catch(e){} } isCamOn=true; syncLocalTracks(); attachCamStream(camStream,'Preview'); emitMediaState(); updateUiState(); forceNegotiate('cam'); setStatus('Camera started.'); }
    catch(err){ setStatus('Camera failed: '+((err&&err.message)?err.message:String(err))); }
  }

  function cleanupRemote(){
    if(negotiationTimer.main) clearTimeout(negotiationTimer.main); if(negotiationTimer.cam) clearTimeout(negotiationTimer.cam);
    if(pcMain){ try{pcMain.close()}catch(e){} pcMain=null; }
    if(pcCam){ try{pcCam.close()}catch(e){} pcCam=null; }
    mainSenders={audio:null,video:null}; camSenders={video:null}; remoteSocketId=null; pendingIce={main:[],cam:[]}; makingOffer={main:false,cam:false}; needsNegotiation={main:false,cam:false};
    clearRemoteView();
  }
  function resetAll(){
    cleanupRemote(); if(socket){ try{socket.disconnect()}catch(e){} socket=null; }
    stopTracks(localAudioStream); stopTracks(screenStream); stopTracks(camStream);
    localAudioStream=null; screenStream=null; camStream=null; inRoom=false; joinedRole='viewer'; isHost=false; isMicOn=false; isSharing=false; isCamOn=false; viewerFullscreen=false; viewerSideHidden=false; remoteHostName='Host';
    disposeMixedSources();
    if(mixedAudioContext){ try{ mixedAudioContext.close(); }catch(e){} }
    mixedAudioContext=null; mixedAudioDestination=null; mixedOutgoingTrack=null;
    setRole('Viewer'); setCount(0); updateHostIdentity('Host'); updateUiState(); clearRemoteView();
  }
  async function joinRoom(){
    if(inRoom) return;
    var roomId=sanitizeRoomId(els.roomInput.value); var displayName=els.nameInput.value.trim()||'Guest'; var password=els.passwordInput.value; joinedRole=els.deviceMode.value||'viewer';
    if(!roomId){ setStatus('Enter a room code first.'); return; }
    els.roomInput.value=roomId;
    if(!ensureSocket()) return;
    try{
      setStatus('Opening required microphone...');
      localAudioStream=await getMicStream(); isMicOn=true; inRoom=true; setRole(joinedRole==='host'?'Host':'Viewer'); viewerFullscreen=false; viewerSideHidden=false; updateUiState();
      els.remoteVideo.muted=joinedRole==='host';
      if(joinedRole==='host') updateHostIdentity(displayName);
      syncLocalTracks();
      socket.emit('join-room',{roomId:roomId,displayName:displayName,requestedRole:joinedRole,password:password});
    }catch(err){ setStatus('Mic failed: '+((err&&err.message)?err.message:String(err))); resetAll(); }
  }
  function leaveRoom(){ resetAll(); setStatus('Left room.'); ensureSocket(); }
  function copyRoom(){ var text=els.roomInput.value.trim(); if(!text){setStatus('Nothing to copy yet.');return} navigator.clipboard.writeText(text).then(function(){setStatus('Room code copied.')}).catch(function(){setStatus('Copy failed. Copy manually.')}) }

  els.generateRoomBtn.addEventListener('click',function(){ if(inRoom) return; els.roomInput.value=shortCode(); setStatus('Short room code generated.'); });
  els.copyRoomBtn.addEventListener('click',copyRoom); els.joinBtn.addEventListener('click',joinRoom); els.shareBtn.addEventListener('click',toggleScreenShare); els.micBtn.addEventListener('click',toggleMic); els.camBtn.addEventListener('click',toggleCam); els.leaveBtn.addEventListener('click',leaveRoom); if(els.viewerFullscreenBtn) els.viewerFullscreenBtn.addEventListener('click',toggleViewerFullscreen); if(els.toggleSideBtn) els.toggleSideBtn.addEventListener('click',toggleViewerSide); els.refreshRoomsBtn.addEventListener('click',function(){ ensureSocket() && socket.emit('get-room-list') });

  els.remoteVideo.controls=false; els.camVideo.controls=false; els.remoteVideo.muted=false; els.camVideo.muted=true;
  els.remoteVideo.setAttribute('playsinline',''); els.camVideo.setAttribute('playsinline','');
  if(els.remoteAudio){ els.remoteAudio.autoplay=true; els.remoteAudio.setAttribute('playsinline',''); els.remoteAudio.muted=false; els.remoteAudio.volume=1; }
  document.addEventListener('fullscreenchange', function(){
    if(!document.fullscreenElement && viewerFullscreen){ viewerFullscreen=false; viewerSideHidden=false; syncViewerFullscreenUi(); }
  });
  els.roomInput.value=location.hash&&location.hash.length>1?sanitizeRoomId(decodeURIComponent(location.hash.slice(1))):shortCode();
  updateHostIdentity('Host'); clearRemoteView(); updateUiState(); ensureSocket();
})();
