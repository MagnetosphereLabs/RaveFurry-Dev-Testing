/* A bounded 720p GPU decoder, drawn under the existing scene GPU fence. */
(() => {
  'use strict';
  const port=Number(new URLSearchParams(location.search).get('port')||location.port||8766);
  if(!Number.isInteger(port)||port<1024||port>65535)return;
  const origin='http://127.0.0.1:'+port, socketOrigin='ws://127.0.0.1:'+port;
  const ease='cubic-bezier(.22,1,.36,1)',clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  let state=null,token='',stopped=false,obsVisible=true,shown=false,root=null,surface=null,status=null;
  let player=null,socket=null,fetcher=null,library=null,libraryScript=null;
  let retired=Promise.resolve();
  let generation=0,inputGeneration=-1,retry=0,reconnect=0,watch=0,retire=0,moveFrame=0;
  let effects=new Set(),drag=null,geometry=null,ratio=16/9,lastTime=0,lastProgress=0;
  let clientRetry=0,playerRetire=0,failures=0,loadTicket=0,blockedGeneration=-1;
  let leaseAbort=null,leaseRelease=null,leaseSupported=Boolean(navigator.locks?.request),leaseOwned=!leaseSupported,excessBuffer=0;
  let opaqueRect=null,pictureVisible=false,displayRect=null,revealAt=0,exitAt=0;
  const crop=new Float32Array([0,0,1,1]);
  const visible=()=>obsVisible&&!document.hidden;
  const active=()=>!stopped&&visible()&&state?.layout==='video'&&state.enabled&&!state.suspended&&!window.FuraticOBSPresentation?.active;
  function animate(node,frames,duration=550){
    if(!node?.animate)return;
    for(const a of [...effects])if(a.effect?.target===node){clearTimeout(a._deadline);a.onfinish=a.oncancel=null;a.cancel();a.effect=null;effects.delete(a);}
    const a=node.animate(frames,{duration,easing:ease,fill:'none'});effects.add(a);
    const release=()=>{clearTimeout(a._deadline);a.onfinish=a.oncancel=null;a.cancel();if(a.effect)a.effect.target=null;a.effect=null;effects.delete(a);};
    a.onfinish=a.oncancel=release;a._deadline=setTimeout(release,duration+100);
  }
  function cancelEffects(){for(const a of [...effects]){clearTimeout(a._deadline);a.onfinish=a.oncancel=null;a.cancel();if(a.effect)a.effect.target=null;a.effect=null;}effects.clear();}
  function showStatus(text){
    if(!status||status.textContent===text)return;
    status.textContent=text;status.hidden=!text;
    if(text)animate(status,[{opacity:0,transform:'translate(-50%,calc(-50% + 6px)) scale(.96)'},{opacity:1,transform:'translate(-50%,-50%)'}],350);
  }
  function teardownPlayer(clearRetry=true){
    ++generation;if(clearRetry){clearTimeout(clientRetry);clientRetry=0;}clearTimeout(playerRetire);playerRetire=0;clearInterval(watch);watch=0;
    const old=player;player=null;pictureVisible=false;revealAt=exitAt=0;
    if(old){const release=old.close();retired=Promise.all([retired,release]).then(()=>{},()=>{});}lastTime=lastProgress=0;
  }
  function releaseLease(){leaseAbort?.abort();leaseAbort=null;const release=leaseRelease;leaseRelease=null;if(leaseSupported)leaseOwned=false;release?.();}
  function acquireLease(){
    if(leaseOwned||leaseAbort||!active())return;
    const abort=leaseAbort=new AbortController();
    navigator.locks.request('furatic-obs-video-'+port,{signal:abort.signal},async()=>{
      if(abort.signal.aborted||!active())return;
      leaseOwned=true;
      await new Promise(resolve=>{leaseRelease=resolve;sync();});
    }).catch(error=>{
      // Older/local-file CEF contexts may expose but reject Web Locks. The
      // backend still enforces one media connection in that case.
      if(error?.name!=='AbortError'&&leaseAbort===abort){leaseSupported=false;leaseOwned=true;leaseAbort=null;if(active())sync();}
    }).finally(()=>{if(leaseAbort===abort){leaseAbort=null;leaseOwned=!leaseSupported;}});
    showStatus('Video is active in another display — waiting…');
  }
  function size(){return {w:innerWidth||1920,h:innerHeight||1080};}
  function applyGeometry(value=geometry){
    if(!root)return;const {w,h}=size();
    const top=document.getElementById('obs-topbar')?.getBoundingClientRect().bottom||h*.23;
    const bottom=h-(24+325*.75)*h/1080;
    const auto=Math.min(w*.94,Math.max(h*.15,bottom-top-30*h/1080)*ratio);
    let width=value?.width>0?value.width*w:auto;width=clamp(width,Math.min(w*.15,h*.15*ratio),Math.min(w*.98,h*.96*ratio));
    const height=width/ratio;
    const x=clamp((value?.x??.5)*w,width/2,w-width/2),y=clamp((value?.y??.5)*h,height/2,h-height/2);
    root.style.left=x+'px';root.style.top=y+'px';root.style.width=width+'px';root.style.height=height+'px';
    displayRect={left:x-width/2,top:y-height/2,width,height};
    // Inset beyond the rounded corners/border: only completely covered pixels
    // can be omitted by the background renderer. No DOM reads in its frame loop.
    const inset=22;
    opaqueRect=width>inset*2&&height>inset*2?{left:x-width/2+inset,top:y-height/2+inset,right:x+width/2-inset,bottom:y+height/2-inset}:null;
    root.style.cursor=state?.locked?'default':'move';
    root.dataset.locked=String(Boolean(state?.locked));
  }
  async function patch(value){
    if(!token||stopped)return;
    try{const r=await fetch(origin+'/video/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Furatic-Video-Token':token},body:JSON.stringify(value)});if(!r.ok)throw new Error();}
    catch(_){showStatus('Position could not be saved');}
  }
  function feedback(message){
    if(!token||stopped)return;
    fetch(origin+'/video/playback',{method:'POST',headers:{'Content-Type':'application/json','X-Furatic-Video-Token':token},body:JSON.stringify({message,generation:state.generation})}).catch(()=>{});
  }
  function endDrag(){
    if(!drag)return;const id=drag.id;drag=null;
    if(moveFrame){cancelAnimationFrame(moveFrame);moveFrame=0;}applyGeometry();
    try{root?.releasePointerCapture?.(id);}catch(_){}
    patch({geometry});
  }
  function move(event){
    if(!drag||event.pointerId!==drag.id)return;event.preventDefault();
    const {w,h}=size(),dx=event.clientX-drag.mx,dy=event.clientY-drag.my;
    let width=drag.width,x=drag.x,y=drag.y;
    if(drag.edge){
      const horizontal=drag.edge.includes('e')?dx:drag.edge.includes('w')?-dx:0;
      const vertical=(drag.edge.includes('s')?dy:drag.edge.includes('n')?-dy:0)*ratio;
      const delta=drag.edge.length===2?(Math.abs(horizontal)>Math.abs(vertical)?horizontal:vertical):drag.edge==='e'||drag.edge==='w'?horizontal:vertical;
      width=clamp(drag.width+delta,Math.min(w*.15,h*.15*ratio),Math.min(w*.98,h*.96*ratio));
      const change=width-drag.width;
      if(drag.edge.includes('e'))x+=change/2;if(drag.edge.includes('w'))x-=change/2;
      if(drag.edge.includes('s'))y+=change/ratio/2;if(drag.edge.includes('n'))y-=change/ratio/2;
    }else{
      x+=dx;y+=dy;const snap=12*h/1080;
      if(Math.abs(x-w/2)<snap)x=w/2;if(Math.abs(y-h/2)<snap)y=h/2;
    }
    x=clamp(x,width/2,w-width/2);y=clamp(y,width/ratio/2,h-width/ratio/2);
    geometry={x:x/w,y:y/h,width:width/w};
    if(!moveFrame)moveFrame=requestAnimationFrame(()=>{moveFrame=0;applyGeometry();});
  }
  function mount(){
    if(root)return;root=document.createElement('div');root.id='obs-video-window';
    root.innerHTML='<div class="obs-video-surface"><div class="obs-video-status" role="status">Waiting for video…</div></div>'+['n','s','e','w','ne','nw','se','sw'].map(edge=>'<div class="obs-video-handle" data-edge="'+edge+'"></div>').join('');
    surface=root.querySelector('.obs-video-surface');status=root.querySelector('.obs-video-status');
    root.addEventListener('pointerdown',event=>{
      player?.resume();if(state?.locked||event.button!==0||!active())return;event.preventDefault();
      const b=root.getBoundingClientRect();drag={id:event.pointerId,mx:event.clientX,my:event.clientY,x:b.left+b.width/2,y:b.top+b.height/2,width:b.width,edge:event.target.dataset.edge||''};
      try{root.setPointerCapture(event.pointerId);}catch(_){}
    });
    root.addEventListener('pointermove',move);root.addEventListener('pointerup',endDrag);root.addEventListener('pointercancel',endDrag);root.addEventListener('lostpointercapture',endDrag);
    document.body.appendChild(root);applyGeometry();
    animate(surface,[{opacity:0,transform:'translateY(18px) scale(.92)'},{opacity:1,transform:'none'}],650);
  }
  function removeRoot(){
    clearTimeout(retire);retire=0;teardownPlayer();releaseLease();cancelEffects();
    if(moveFrame)cancelAnimationFrame(moveFrame);moveFrame=0;drag=null;root?.remove();root=surface=status=null;
  }
  function stopDisplay(immediate=false){
    ++loadTicket;shown=false;blockedGeneration=-1;clearTimeout(clientRetry);clientRetry=0;
    clearInterval(watch);watch=0;drag=null;
    if(!root){teardownPlayer();releaseLease();return;}
    if(immediate){removeRoot();return;}
    if(retire)return;
    exitAt=performance.now();player?.audio(0,true);
    animate(surface,[{opacity:1,transform:'none'},{opacity:0,transform:'translateY(12px) scale(.94)'}],400);
    surface.style.opacity='0';retire=setTimeout(removeRoot,420);
  }
  function loadLibrary(){
    if(window.FuraticOBSCreateVideoRenderer)return Promise.resolve(window.FuraticOBSCreateVideoRenderer);
    if(library)return library;
    library=new Promise((resolve,reject)=>{
      const script=libraryScript=document.createElement('script');script.src=origin+'/obs-video-renderer.js?v=3';
      script.onload=()=>{script.onload=script.onerror=null;window.FuraticOBSCreateVideoRenderer?resolve(window.FuraticOBSCreateVideoRenderer):reject(new Error('Player unavailable'));};
      script.onerror=()=>{script.onload=script.onerror=null;script.remove();libraryScript=null;library=null;reject(new Error('Player unavailable'));};
      document.head.appendChild(script);
    });return library;
  }
  function reconnectPlayer(message){
    if(!active()||clientRetry)return;
    // A lost connection retires one fixed renderer. A slow GPU does not call
    // this path: it simply withholds frame credit and keeps the newest frame.
    teardownPlayer();showStatus(message||'Reconnecting…');
    const ticket=++loadTicket;
    if(state.status==='receiving')clientRetry=setTimeout(()=>{clientRetry=0;if(ticket===loadTicket&&active())startPlayer();},Math.min(10000,500*2**Math.min(failures++,5)));
  }
  async function startPlayer(){
    if(!active()||!leaseOwned||state.status!=='receiving'||player||clientRetry)return;const ticket=++loadTicket;
    try{
      const create=await loadLibrary();if(stopped||ticket!==loadTicket||!active())return;
      teardownPlayer();await retired;
      if(stopped||ticket!==loadTicket||!active()||!leaseOwned||state.status!=='receiving')return;
      const current=++generation;
      player=create({origin,url:socketOrigin+'/video/live',volume:state.volume,muted:state.muted,
        onFrame(){if(current!==generation||!active())return;failures=0;showStatus('');
          if(!pictureVisible){pictureVisible=true;revealAt=performance.now();feedback('');}},
        onError(message,fatal=false){if(current!==generation)return;if(fatal){blockedGeneration=state.generation;teardownPlayer();showStatus(message);feedback(String(message).slice(0,160));}else reconnectPlayer(message);}});
      await player.start();
    }catch(_){if(ticket===loadTicket&&active())reconnectPlayer('Loading video and audio…');}
  }
  function sync(){
    if(stopped||!state)return;
    const layout=state.layout==='video'&&!window.FuraticOBSPresentation?.active;
    window.FuraticOBSUI?.setVideoLayout?.(layout);window.FuraticOBSForeground?.setVideoLayout?.(layout);
    if(!active()){stopDisplay(!visible());return;}
    if(retire){clearTimeout(retire);retire=0;teardownPlayer();cancelEffects();if(surface){surface.style.opacity='1';animate(surface,[{opacity:0,transform:'scale(.94)'},{opacity:1,transform:'none'}],400);}}
    shown=true;mount();
    acquireLease();if(!leaseOwned)return;
    if(!drag){geometry=state.geometry;applyGeometry();}
    player?.audio(state.volume,state.muted);
    const media=state.media||{},sw=media.sourceWidth,sh=media.sourceHeight;
    if(sw>0&&sh>0){ratio=sw/sh;const scale=Math.min(1280/sw,720/sh),cw=Math.floor(sw*scale/2)*2,ch=Math.floor(sh*scale/2)*2;
      crop.set([Math.floor((1280-cw)/4)*2/1280,Math.floor((720-ch)/4)*2/720,cw/1280,ch/720]);if(!drag)applyGeometry();}
    if(state.generation!==inputGeneration){inputGeneration=state.generation;teardownPlayer();++loadTicket;}
    if(blockedGeneration===state.generation)return;
    if(state.status!=='receiving'&&player&&!playerRetire)reconnectPlayer(state.status==='error'?state.detail:'Reconnecting…');
    if(state.status==='error')showStatus(state.detail);
    else if(!pictureVisible)showStatus(state.status==='receiving'?'Loading video…':state.status==='reconnecting'?'Reconnecting…':'Waiting for video…');
    if(state.status==='receiving'&&!player&&!clientRetry)startPlayer();
  }
  function receive(value){
    if(!value||!['default','video'].includes(value.layout)||typeof value.enabled!=='boolean'||!value.geometry||!Number.isFinite(value.volume))return;
    state=value;if(value.token)token=value.token;sync();
  }
  async function connect(){
    if(stopped||!visible())return;
    clearTimeout(reconnect);reconnect=0;fetcher?.abort();const controller=fetcher=new AbortController();
    try{
      const response=await fetch(origin+'/video/state?controls=1',{cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error();
      const value=await response.json();if(stopped||controller.signal.aborted||!visible())return;receive(value);
      if(socket){socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;socket.close();}
      const ws=socket=new WebSocket(socketOrigin+'/video/events');
      ws.onopen=()=>{retry=0;};ws.onmessage=event=>{if(socket===ws&&!stopped)try{receive(JSON.parse(event.data));}catch(_){}};
      ws.onerror=()=>ws.close();ws.onclose=()=>{if(socket===ws){socket=null;schedule();}};
    }catch(_){if(!controller.signal.aborted)schedule();}
    finally{if(fetcher===controller)fetcher=null;}
  }
  function schedule(){if(!stopped&&visible()&&!reconnect)reconnect=setTimeout(connect,Math.min(10000,1000*2**Math.min(retry++,4)));}
  function visibility(event){
    if(typeof event?.detail?.visible==='boolean')obsVisible=event.detail.visible;
    if(!visible()){
      clearTimeout(reconnect);reconnect=0;fetcher?.abort();
      if(socket){socket.onclose=socket.onmessage=socket.onerror=socket.onopen=null;socket.close();socket=null;}
      stopDisplay(true);
    }else{sync();if(!socket)connect();}
  }
  function resize(){if(root&&!drag)applyGeometry();}
  function scene(){sync();}
  window.FuraticOBSVideo={get active(){return shown;},get layout(){return state?.layout||'default';},
    get opaqueRect(){return active()&&shown&&pictureVisible&&!effects.size&&!exitAt&&performance.now()-revealAt>=500?opaqueRect:null;},
    get stats(){return player?.stats||null;},
    draw(gl,w,h){
      if(!player||!displayRect||(!active()&&!retire))return;
      const now=performance.now(),enter=revealAt?clamp((now-revealAt)/500,0,1):0,leave=exitAt?clamp((now-exitAt)/400,0,1):0;
      const eased=1-Math.pow(1-enter,3),out=1-Math.pow(1-leave,3),scale=(.97+.03*eased)*(1-.06*out);
      const sx=w/Math.max(1,innerWidth),sy=h/Math.max(1,innerHeight),r=displayRect;
      const rect=[(r.left+r.width*(1-scale)*.5)*sx,(r.top+r.height*(1-scale)*.5+12*out)*sy,r.width*scale*sx,r.height*scale*sy];
      try{player.draw(gl,w,h,rect,crop,eased*(1-out));}catch(_){reconnectPlayer('Video graphics recovering…');}
    },
    complete(){player?.complete();},graphicsLost(valid=false){player?.graphicsLost(valid);}};
  window.addEventListener('obsSourceVisibleChanged',visibility);document.addEventListener('visibilitychange',visibility);
  window.addEventListener('resize',resize);window.addEventListener('blur',endDrag);window.addEventListener('furatic:scenechange',scene);
  window.addEventListener('pagehide',()=>{
    stopped=true;fetcher?.abort();clearTimeout(reconnect);stopDisplay(true);
    if(socket){socket.onclose=socket.onmessage=socket.onerror=socket.onopen=null;socket.close();socket=null;}
    if(libraryScript){libraryScript.onload=libraryScript.onerror=null;libraryScript.remove();libraryScript=null;}library=null;
    window.removeEventListener('obsSourceVisibleChanged',visibility);document.removeEventListener('visibilitychange',visibility);
    window.removeEventListener('resize',resize);window.removeEventListener('blur',endDrag);window.removeEventListener('furatic:scenechange',scene);
    state=null;token='';delete window.FuraticOBSVideo;
  },{once:true});
  visibility();
})();
