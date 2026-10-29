/* Local broadcast graphics. Fixed GPU resources, latest-state audio, bounded images. */
(() => {
  'use strict';
  const ease='cubic-bezier(.22,1,.36,1)', clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
  const options=new URLSearchParams(location.search);
  const port=Number(options.get('port')||(location.protocol==='http:'&&['127.0.0.1','localhost'].includes(location.hostname)?location.port:8766));
  if(!Number.isInteger(port)||port<1024||port>65535)return;
  const origin='http://127.0.0.1:'+port;
  // Only one native image decode can run. Replacements overwrite fixed keyed
  // slots; canceling a decode never starts a second one behind its back.
  const imageQueue=new Map();let imageJob=null;
  function cancelImage(key){
    const queued=imageQueue.get(key);if(queued){queued.paint=null;queued.abort.abort();imageQueue.delete(key);}
    if(imageJob?.key===key){imageJob.paint=null;imageJob.abort.abort();}
  }
  function loadImage(key,path,paint,width=512){
    cancelImage(key);imageQueue.set(key,{key,path,paint,width,abort:new AbortController()});pumpImages();
  }
  async function pumpImages(){
    if(imageJob||!imageQueue.size)return;
    const [key,job]=imageQueue.entries().next().value;imageQueue.delete(key);imageJob=job;
    const timeout=setTimeout(()=>{job.paint=null;job.abort.abort();},5000);let bitmap=null;
    try{
      const response=await fetch(origin+job.path,{cache:'no-store',credentials:'omit',signal:job.abort.signal});
      if(!response.ok)return;
      const blob=await response.blob();if(!blob.size||blob.size>5*1024*1024||job.abort.signal.aborted)return;
      const sizing=job.path.startsWith('/assets/')?{resizeWidth:job.width,resizeQuality:'high'}:{};
      bitmap=await createImageBitmap(blob,{...sizing,premultiplyAlpha:'none'});
      if(!job.abort.signal.aborted)job.paint?.(bitmap);
    }catch(_error){/* Missing local graphics cannot stop the broadcast. */}
    finally{bitmap?.close();clearTimeout(timeout);job.abort.abort();job.paint=null;imageJob=null;pumpImages();}
  }
  window.FuraticOBSCreateForeground=function(gl,initialVisibility=true){
    let resources=null,enabled=!window.FuraticOBSPresentation?.active,showing=Boolean(initialVisibility)&&!document.hidden,dead=false,alpha=enabled?1:0;
    const desired=new Float32Array(26),bands=new Float32Array(26),color=new Float32Array([1,1,1,0]),desiredColor=new Float32Array([1,1,1,0]);
    let targetScale=.7,scale=.7,received=-Infinity;
    let videoLayout=window.FuraticOBSVideo?.layout==='video',barHeight=videoLayout?.62:1,logoAlpha=videoLayout?0:1;
    const vertex=`#version 300 es
    precision highp float;precision highp int;
    uniform vec2 u_resolution;uniform float u_bands[26];uniform float u_scale;uniform float u_opacity;uniform float u_barHeight;uniform int u_logo;
    out vec2 v_uv;out vec2 v_size;
    void main(){
      vec2 corner=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));vec2 pixel;
      if(u_logo==1){
        float width=u_resolution.y*.48148148*u_scale*(.92+.08*u_opacity);
        pixel=u_resolution*.5+(corner-.5)*width;v_size=vec2(width);
      }else{
        float sx=u_resolution.x/1920.;float sy=u_resolution.y/1080.;float area=1420.*sx;
        float height=(42.+283.*u_bands[gl_InstanceID])*u_barHeight;v_size=vec2(42.,height);
        float left=(u_resolution.x-area*1242./1280.)*.5+float(gl_InstanceID)*48./1280.*area;
        pixel=vec2(left+corner.x*42./1280.*area,u_resolution.y-24.*sy-height*sy+corner.y*height*sy+(1.-u_opacity)*85.*sy);
      }
      v_uv=corner;gl_Position=vec4(pixel.x/u_resolution.x*2.-1.,1.-pixel.y/u_resolution.y*2.,0.,1.);
    }`;
    const fragment=`#version 300 es
    precision highp float;precision highp int;in vec2 v_uv;in vec2 v_size;
    uniform vec4 u_color;uniform sampler2D u_texture;uniform float u_opacity;uniform int u_logo;out vec4 fragColor;
    void main(){
      if(u_logo==1){fragColor=texture(u_texture,v_uv);fragColor.a*=u_opacity;}
      else{float radius=min(21.,v_size.y*.5);vec2 p=abs(v_uv*v_size-v_size*.5)-(v_size*.5-radius);float distance=length(max(p,0.))+min(max(p.x,p.y),0.)-radius;float edge=max(.5,fwidth(distance));fragColor=vec4(u_color.rgb,u_color.a*u_opacity*(1.-smoothstep(-edge,edge,distance)));}
    }`;
    function free(valid=true){
      cancelImage('foreground-logo');
      if(resources&&valid){gl.deleteTexture(resources.texture);gl.deleteVertexArray(resources.vao);gl.deleteProgram(resources.program);}
      resources=null;
    }
    function freeLogo(){
      cancelImage('foreground-logo');
      if(resources?.texture&&(resources.ready||resources.logoRequested)){
        // Retain only a four-byte complete sampler for the shared bar shader.
        // Replacing its storage releases the decoded logo's GPU backing.
        gl.bindTexture(gl.TEXTURE_2D,resources.texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
        resources.ready=false;resources.logoRequested=false;
      }
    }
    function ensureLogo(){
      const current=resources;if(!current||current.logoRequested||videoLayout||!enabled||!showing)return;
      const texture=current.texture;current.logoRequested=true;
      loadImage('foreground-logo','/assets/FuraticLogo.png',bitmap=>{
        if(resources!==current||current.texture!==texture||dead||!enabled||!showing||videoLayout)return;
        gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);current.ready=true;
      },768);
    }
    function initialize(){
      if(resources||dead||!enabled||!showing)return;
      const shaders=[];let program=null,texture=null,vao=null;
      try{
        for(const[type,source]of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
          const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
          if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('Foreground shader compilation failed');
        }
        program=gl.createProgram();for(const shader of shaders)gl.attachShader(program,shader);gl.linkProgram(program);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Foreground shader link failed');
        for(const shader of shaders)gl.detachShader(program,shader);
        texture=gl.createTexture();vao=gl.createVertexArray();if(!texture||!vao)throw new Error('Foreground allocation failed');
        const at=name=>gl.getUniformLocation(program,name);
        const current={program,texture,vao,ready:false,logoRequested:false,resolution:at('u_resolution'),bands:at('u_bands[0]'),scale:at('u_scale'),opacity:at('u_opacity'),barHeight:at('u_barHeight'),logo:at('u_logo'),color:at('u_color'),sampler:at('u_texture')};
        resources=current;
        gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
        ensureLogo();
      }catch(_error){if(texture)gl.deleteTexture(texture);if(vao)gl.deleteVertexArray(vao);if(program)gl.deleteProgram(program);resources=null;enabled=false;}
      finally{for(const shader of shaders)gl.deleteShader(shader);}
    }
    const api={
      receive(value){
        if(!value||!Array.isArray(value.bands)||value.bands.length!==26||!value.bands.every(Number.isFinite)||!Array.isArray(value.color)||value.color.length!==4||!value.color.every(Number.isFinite)||!Number.isFinite(value.logoScale))return;
        desired.set(value.bands);desiredColor.set(value.color);targetScale=clamp(value.logoScale,.7,1);received=performance.now()/1000;
      },
      setEnabled(value){enabled=Boolean(value);},
      setVideoLayout(value){videoLayout=Boolean(value);},
      visibility(value){showing=Boolean(value);if(!showing){free();bands.fill(0);desired.fill(0);scale=targetScale=.7;}},
      update(dt,now){
        if(dead)return;const fresh=now-received<.3;
        for(let i=0;i<26;i++)bands[i]+=(clamp(fresh?desired[i]:0)-bands[i])*(1-Math.exp(-dt/.022));
        for(let i=0;i<4;i++)color[i]+=((fresh?clamp(desiredColor[i]):i===3?0:1)-color[i])*(1-Math.exp(-dt/.035));
        if(logoAlpha>.003||!videoLayout)scale+=((fresh?targetScale:.7)-scale)*(1-Math.exp(-dt/.035));
        barHeight+=((videoLayout?.62:1)-barHeight)*(1-Math.exp(-dt/.16));
        logoAlpha+=((videoLayout?0:1)-logoAlpha)*(1-Math.exp(-dt/.10));
        if(videoLayout&&logoAlpha<.003){logoAlpha=0;freeLogo();}
        alpha+=((enabled?1:0)-alpha)*(1-Math.exp(-dt/.13));
        if(!enabled&&alpha<.003){alpha=0;if(resources)free();}
      },
      draw(width,height){
        if(dead||!showing||alpha<=.003)return;initialize();ensureLogo();const r=resources;if(!r)return;
        // Guard the actual visible logo bounds against both the bar peaks and
        // the existing top bar, while retaining the centered 70–100% response.
        const topbar=document.getElementById('obs-topbar');
        const top=topbar&&!topbar.hidden?topbar.getBoundingClientRect().bottom*height/innerHeight:0;
        let peak=0;for(const band of bands)peak=Math.max(peak,band);
        const barsTop=height-(24+42+283*peak)*height/1080;
        const base=height*.48148148;
        const fitted=Math.max(.1,Math.min(scale,(height*.5-top-16*height/1080)/(.414*base),(barsTop-height*.5-16*height/1080)/(.443*base)));
        gl.useProgram(r.program);gl.bindVertexArray(r.vao);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform2f(r.resolution,width,height);gl.uniform1fv(r.bands,bands);gl.uniform1f(r.opacity,alpha);gl.uniform1f(r.barHeight,barHeight);gl.uniform1f(r.scale,fitted);gl.uniform4fv(r.color,color);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,r.texture);gl.uniform1i(r.sampler,0);
        gl.uniform1i(r.logo,0);gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,26);
        if(r.ready&&logoAlpha>.003){gl.uniform1f(r.opacity,alpha*logoAlpha);gl.uniform1i(r.logo,1);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);}
        gl.disable(gl.BLEND);gl.bindVertexArray(null);
      },
      dispose(valid=true){if(dead)return;dead=true;free(valid);if(window.FuraticOBSForeground===api)delete window.FuraticOBSForeground;},
    };
    window.FuraticOBSForeground=api;initialize();return api;
  };

  window.FuraticOBSStartPresentation=function(){
    const ui=window.FuraticOBSUI;if(!ui||window.FuraticOBSPresentation)return;
    const bar=document.getElementById('obs-topbar');
    const storageKey='furatic.obs.afterhours.v1';
    let stopped=false,active=false,showing=true,cutoff=0,eventId='',results=null,requested='',resultsAbort=null;
    let root=null,content=null,stage='none',stageAt=0,deadline=0,raf=0,index=-1,rowBase=-1,scrollStart=0,rows=[],thanks=null,listRowSize=0,listHeight=0,returnAt=0,returnFrom=0;
    const layouts=new Set(),imageKeys=new Map(),awardTimers=new Map();let pendingTimer=0,retireTimer=0,retiring=null,panelSerial=0;
    let awardAudio=null,awardAudioRank=0,awardAudioTimer=0;
    const storage={read(){try{return JSON.parse(localStorage.getItem(storageKey)||'null');}catch(_){return null;}},write(value){try{localStorage.setItem(storageKey,JSON.stringify(value));}catch(_){}}};
    const text=(element,value,digits=false)=>{layouts.add(element);ui.text(element,value,digits);};
    const label=(element,value)=>{layouts.add(element);ui.label(element,value);};
    function awardPhase(panel,delay,run){
      const timer=setTimeout(()=>{awardTimers.delete(timer);if(active&&showing&&panel.isConnected)run();},delay);
      awardTimers.set(timer,panel);
    }
    function cancelAwardPhases(panel=null){
      for(const [timer,owner] of awardTimers)if(!panel||panel===owner||panel.contains(owner)){clearTimeout(timer);awardTimers.delete(timer);}
    }
    function releaseAwardSound(){
      clearTimeout(awardAudioTimer);awardAudioTimer=0;
      const sound=awardAudio;awardAudio=null;awardAudioRank=0;
      if(!sound)return;
      sound.onended=sound.onerror=null;sound.pause();sound.removeAttribute('src');sound.load();
    }
    function prepareAwardSound(rank){
      if(!active||!showing||rank<1||rank>Math.min(3,results?.songs.length||0))return;
      if(awardAudio&&awardAudioRank===rank)return;
      releaseAwardSound();
      // One small, pre-rendered PCM cue at a time. Loading the next rank in
      // the quiet hold avoids decoding/synthesizing effects during a reveal.
      const sound=new Audio();awardAudio=sound;awardAudioRank=rank;
      sound.preload='auto';sound.volume=.85;sound.loop=false;
      sound.onerror=()=>{if(awardAudio===sound)releaseAwardSound();};
      sound.onended=()=>{
        if(awardAudio!==sound)return;
        releaseAwardSound();
        if(stage==='winner'&&index===rank-1)prepareAwardSound(rank+1);
      };
      sound.src=origin+'/assets/award-'+rank+'.wav';sound.load();
      awardAudioTimer=setTimeout(()=>{if(awardAudio===sound)releaseAwardSound();},16000);
    }
    function playAwardSound(rank){
      prepareAwardSound(rank);const sound=awardAudio;if(!sound)return;
      clearTimeout(awardAudioTimer);
      // A stalled/missing file cannot leave a media pipeline alive or delay
      // the presentation. Rejected autoplay never retries in the background.
      awardAudioTimer=setTimeout(()=>{if(awardAudio===sound)releaseAwardSound();},8000);
      try{const playing=sound.play();playing?.catch(()=>{if(awardAudio===sound)releaseAwardSound();});}
      catch(_error){if(awardAudio===sound)releaseAwardSound();}
    }
    function cancelGraphics(panel=null){for(const [key,canvas] of imageKeys)if(!panel||panel.contains(canvas)){cancelImage(key);imageKeys.delete(key);}}
    function releasePanel(panel){
      if(!panel)return;for(const element of [...layouts])if(panel===element||panel.contains(element)){ui.release(element);layouts.delete(element);}
      cancelAwardPhases(panel);cancelGraphics(panel);
      ui.remove(panel);
    }
    function clearStage(){
      releaseAwardSound();cancelAwardPhases();cancelGraphics();if(root){for(const child of [...root.children])releasePanel(child);}rows=[];content=thanks=null;rowBase=-1;
    }
    function cover(canvas,video,key,size=512,reveal=true){
      cancelImage(key);imageKeys.delete(key);canvas.width=canvas.height=0;canvas.classList.remove('has-artwork');
      if(!video)return;
      imageKeys.set(key,canvas);loadImage(key,'/results-artwork/'+video,bitmap=>{
        if(!active||!showing||!canvas.isConnected)return;
        ui.paint(canvas,bitmap,size);canvas.classList.add('has-artwork');
        if(reveal)ui.animate(canvas,[{opacity:0,transform:'scale(.94)',filter:'blur(3px)'},{opacity:1,transform:'none',filter:'none'}],{duration:420,easing:ease});
      },size);
    }
    function trophy(rank){
      const node=document.createElement('div');node.className='obs-showcase-trophy';node.dataset.rank=String(rank);
      const source=document.querySelector('#vote-notice-badge .vote-notice-medal');
      if(source){
        const svg=source.cloneNode(true);const prefix='showcase-medal-'+rank+'-'+(++panelSerial)+'-';
        svg.querySelectorAll('[id]').forEach(item=>{item.id=prefix+item.id;});
        svg.querySelectorAll('[fill]').forEach(item=>{const fill=item.getAttribute('fill');if(fill.startsWith('url(#'))item.setAttribute('fill',fill.replace('url(#','url(#'+prefix));});
        const ordinal=svg.querySelector('.vote-notice-ordinal');if(ordinal)ordinal.textContent=['','1st','2nd','3rd'][rank];node.appendChild(svg);
      }
      return node;
    }
    function enter(panel,direction='center'){
      content.appendChild(panel);
      const from=direction==='right'?'translateX(20vw) scale(.94) rotate(2deg)':direction==='bottom'?'translateY(18vh) scale(.95)':'translateY(2vh) scale(.72) rotate(-2deg)';
      // The glass stays stationary. Animate only the content, avoiding a new
      // full-panel blur surface while the chart's labels/artwork are prepared.
      ui.animate(panel,[{opacity:0,transform:from},{opacity:1,transform:'translate(0,-.2vh) scale(1.008)',offset:.8},{opacity:1,transform:'none'}],{duration:1050,easing:ease});
    }
    function exitThen(next){
      const panel=content?.lastElementChild;if(!panel){next();return;}
      cancelAwardPhases(panel);
      ui.animate(panel,[{opacity:1,transform:'none'},{opacity:0,transform:panel.classList.contains('obs-chart')?'translateY(6vh)':'translateX(-24vw) translateY(-1vh) scale(.94) rotate(-2deg)'}],{duration:650,easing:ease});
      clearTimeout(pendingTimer);pendingTimer=setTimeout(()=>{
        if(!active||!showing)return;
        rows=[];rowBase=-1;next();
        pendingTimer=setTimeout(()=>{pendingTimer=0;releasePanel(panel);},490);
      },180);
    }
    function showThanks(final=false){
      stage=final?'thanks-final':'thanks';stageAt=performance.now();deadline=stageAt+7500;
      if(!content){content=document.createElement('div');content.className='obs-showcase-stage';root.appendChild(content);}
      if(thanks)return;
      const panel=document.createElement('section');panel.className='obs-thanks';
      panel.innerHTML='<div class="obs-thanks-float"><canvas class="obs-thanks-brand" aria-label="FURATIC Pass The Aux"></canvas><div class="obs-thanks-heading obs-text-viewport"></div><div class="obs-thanks-copy obs-text-viewport"></div><div class="obs-thanks-schedule obs-text-viewport"></div><div class="obs-thanks-url obs-text-viewport"></div></div>';
      thanks=panel;root.insertBefore(panel,content);
      ui.animate(panel,[{opacity:0,transform:'translateY(2vh) scale(.97)'},{opacity:1,transform:'none'}],{duration:1050,easing:ease});
      text(panel.querySelector('.obs-thanks-heading'),'THANKS FUR COMING!');
      text(panel.querySelector('.obs-thanks-copy'),'Liked this event? Join the group and follow us for more');
      text(panel.querySelector('.obs-thanks-schedule'),'Every Friday at 4:30PM ET!');
      text(panel.querySelector('.obs-thanks-url'),'FURATIC.XYZ');
      const canvas=panel.querySelector('canvas');imageKeys.set('showcase-brand',canvas);
      [...panel.querySelector('.obs-thanks-float').children].forEach((item,i)=>ui.animate(item,[{opacity:0,transform:'translateY(.65em)'},{opacity:1,transform:'none'}],{duration:640,delay:i*75,easing:ease}));
      loadImage('showcase-brand','/assets/FuraticLogoWide.png',bitmap=>{if(active&&canvas.isConnected)ui.paint(canvas,bitmap,1024,630,true);},1024);
    }
    function showWinner(position){
      if(!results||position>=Math.min(3,results.songs.length)){showList();return;}
      index=position;stage='winner';stageAt=performance.now();deadline=stageAt+10000;
      const song=results.songs[position],rank=position+1;
      const panel=document.createElement('section');panel.className='obs-winner';panel.dataset.rank=String(rank);
      panel.innerHTML='<div class="obs-winner-float"><div class="obs-award-emblem"></div><div class="obs-winner-heading"><div class="obs-winner-kicker obs-text-viewport"></div><div class="obs-winner-place obs-text-viewport"></div></div><div class="obs-winner-body"><div class="obs-winner-art"><canvas></canvas></div><div class="obs-winner-copy"><div class="obs-winner-title obs-text-viewport"></div><div class="obs-winner-artist obs-text-viewport"></div><div class="obs-winner-meta"><div class="obs-winner-votes obs-text-viewport"></div><div class="obs-winner-duration obs-text-viewport"></div></div></div></div></div>';
      const emblem=panel.querySelector('.obs-award-emblem'),medal=trophy(rank),art=panel.querySelector('.obs-winner-art');
      emblem.appendChild(medal);content.appendChild(panel);
      playAwardSound(rank);
      // Reserve the final text geometry without running every glyph effect at
      // once. Each phase replaces its plain label using the existing text UI.
      const seconds=Math.max(0,Math.floor(song.duration));
      const values={kicker:'FINAL EVENT RESULTS',place:['FIRST PLACE','SECOND PLACE','THIRD PLACE'][position],title:song.title,artist:song.artist,
        votes:song.votes+' '+(song.votes===1?'VOTE':'VOTES'),duration:String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')};
      for(const [name,value] of Object.entries(values)){
        const field=panel.querySelector('.obs-winner-'+name);field.textContent=value;field.setAttribute('aria-label',value);field.style.visibility='hidden';
      }
      art.style.opacity='0';cover(art.querySelector('canvas'),song.videoId,'showcase-winner',768,false);
      const travel=rank===1?26:rank===2?14:5,duration=rank===1?1600:rank===2?1250:950;
      const shift='translateX(calc(var(--p)*'+travel+'))';
      ui.animate(emblem,[
        {opacity:0,transform:shift+' translateY(1em) scale(.18) rotate(-32deg)',easing:ease},
        {opacity:1,transform:shift+' translateY(-.15em) scale('+(rank===1?1.20:1.10)+') rotate(7deg)',offset:.35,easing:'ease-in-out'},
        {opacity:1,transform:shift+' scale(1.06) rotate(-3deg)',offset:.50,easing:ease},
        {opacity:1,transform:'translateX(-.2em) scale(1.025) rotate(1deg)',offset:.88,easing:'ease-out'},
        {opacity:1,transform:'none'},
      ],{duration,easing:'linear'});
      const crown=medal.querySelector('.vote-notice-crown');
      if(rank===1&&crown)ui.animate(crown,[{opacity:0,transform:'translateY(-.7em) scale(.3)'},{opacity:1,transform:'translateY(.08em) scale(1.12)',offset:.72},{opacity:1,transform:'none'}],{duration:600,delay:250,easing:ease});
      awardBurst(panel,emblem,rank);
      const reveal=(name,delay,digits=false)=>awardPhase(panel,delay,()=>{
        const field=panel.querySelector('.obs-winner-'+name);field.textContent='';field.style.visibility='visible';text(field,values[name],digits);
        ui.animate(field,[{opacity:0,transform:'translate(.7em,.35em) scale(.96)'},{opacity:1,transform:'translateX(-.04em) scale(1.015)',offset:.8},{opacity:1,transform:'none'}],{duration:620,easing:ease});
      });
      // Badge, heading, artwork, then song/artist/votes. Heavy reveals have
      // separate start times; no particle loop, extra canvas or WebGL context.
      reveal('kicker',duration-400);reveal('place',duration-250);
      awardPhase(panel,duration+120,()=>{
        ui.animate(art,[{opacity:0,transform:'translateX(2em) scale(.68) rotate(12deg)'},{opacity:1,transform:'translateX(-.12em) scale(1.045) rotate(-2deg)',offset:.78},{opacity:1,transform:'none'}],{duration:850,easing:ease});
        if(rank<3){
          const sheen=document.createElement('span');sheen.className='obs-award-sheen';sheen.setAttribute('aria-hidden','true');art.appendChild(sheen);
          ui.animate(sheen,[{opacity:0,transform:'translateX(-70%)'},{opacity:rank===1?.7:.4,offset:.35},{opacity:0,transform:'translateX(70%)'}],{duration:650,delay:500,easing:'ease-in-out'});
          awardPhase(panel,1250,()=>ui.remove(sheen));
        }
      });
      reveal('title',duration+420);reveal('artist',duration+680);reveal('votes',duration+970);reveal('duration',duration+1120,true);
    }
    function awardBurst(panel,emblem,rank){
      const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
      svg.setAttribute('class','obs-award-burst');svg.setAttribute('viewBox','0 0 200 200');svg.setAttribute('aria-hidden','true');
      // At most two rings and twelve stars, rasterized only for this brief
      // reveal. Removing the SVG also cancels/detaches every native effect.
      const rings=rank===1?2:rank===2?1:0;
      for(let i=0;i<rings;i++){
        const ring=document.createElementNS(ns,'g'),circle=document.createElementNS(ns,'circle');
        circle.setAttribute('cx','100');circle.setAttribute('cy','100');circle.setAttribute('r','68');circle.setAttribute('fill','none');circle.setAttribute('stroke','currentColor');circle.setAttribute('stroke-width',i?'1':'2');
        ring.appendChild(circle);svg.appendChild(ring);
        ui.animate(ring,[{opacity:0,transform:'scale(.35)'},{opacity:i?.6:.9,offset:.2},{opacity:0,transform:'scale(1.32)'}],{duration:900,delay:300+i*160,easing:ease});
      }
      const stars=document.createElementNS(ns,'g'),count=rank===1?12:rank===2?8:4;
      for(let i=0;i<count;i++){
        const a=(i/count*Math.PI*2)-Math.PI/2,r=i%2?79:88,x=100+Math.cos(a)*r,y=100+Math.sin(a)*r,s=i%2?2.3:4.3;
        const star=document.createElementNS(ns,'path');star.setAttribute('d',`M${x} ${y-s*1.7}L${x+s*.45} ${y-s*.45}L${x+s*1.7} ${y}L${x+s*.45} ${y+s*.45}L${x} ${y+s*1.7}L${x-s*.45} ${y+s*.45}L${x-s*1.7} ${y}L${x-s*.45} ${y-s*.45}Z`);star.setAttribute('fill','currentColor');stars.appendChild(star);
      }
      svg.appendChild(stars);emblem.prepend(svg);
      ui.animate(stars,[{opacity:0,transform:'scale(.35) rotate(-18deg)'},{opacity:1,transform:'scale(.86) rotate(-4deg)',offset:.3},{opacity:0,transform:'scale(1.1) rotate(8deg)'}],{duration:rank===1?1150:rank===2?900:650,delay:rank===1?400:300,easing:ease});
      awardPhase(panel,1800,()=>ui.remove(svg));
    }
    function showList(){
      stage='list';stageAt=performance.now();scrollStart=stageAt+2500;rowBase=-1;deadline=0;listRowSize=listHeight=returnAt=returnFrom=0;
      if(!results?.songs.length){showThanks(true);return;}
      const panel=document.createElement('section');panel.className='obs-chart';
      panel.innerHTML='<header><div class="obs-chart-heading obs-text-viewport"></div><div class="obs-chart-subtitle obs-text-viewport"></div></header><div class="obs-chart-window"><div class="obs-chart-track"></div></div>';
      enter(panel,'bottom');text(panel.querySelector('.obs-chart-heading'),"TOP SONGS FROM TODAY'S EVENT");text(panel.querySelector('.obs-chart-subtitle'),'Ranked by your votes');
      const track=panel.querySelector('.obs-chart-track');
      for(let i=0;i<8;i++){
        const row=document.createElement('div');row.className='obs-chart-row';row.innerHTML='<div class="obs-chart-rank"></div><div class="obs-chart-art"><canvas></canvas></div><div class="obs-chart-copy"><div class="obs-chart-title obs-text-viewport"></div><div class="obs-chart-artist obs-text-viewport"></div></div><div class="obs-chart-votes obs-text-viewport"></div>';
        row._imageKey='showcase-row-'+i;track.appendChild(row);rows.push(row);
      }
      updateList(stageAt);
      const visible=Math.min(rows.length,Math.ceil(listHeight/listRowSize)+1);
      // Stagger only the initial viewport. Recycled/returning rows stay on
      // their scrolling track without replaying entrance effects or blurs.
      rows.slice(0,visible).forEach((row,i)=>[...row.children].forEach((cell,j)=>ui.animate(cell,[{opacity:0,transform:'translate(.4em,.6em)'},{opacity:1,transform:'none'}],{duration:480,delay:220+i*75+j*35,easing:ease})));
    }
    function updateList(now){
      if(!rows.length||!results)return;
      const viewport=root.querySelector('.obs-chart-window');
      const rowHeight=listRowSize||(listRowSize=parseFloat(getComputedStyle(rows[0]).height)||Math.min(innerWidth/100,innerHeight/56.25)*4.6);
      const height=listHeight||(listHeight=viewport.clientHeight||rowHeight*3);
      const maximum=Math.max(0,results.songs.length*rowHeight-height);
      // About 2.5 seconds per complete row, with eased acceleration/braking.
      const elapsed=Math.max(0,(now-scrollStart)/1000),speed=rowHeight/2.5,ramp=1.5;
      const duration=Math.max(4,maximum/speed+ramp);
      const acceleration=t=>{const u=clamp(t/ramp);return speed*ramp*(u*u*u-.5*u*u*u*u);};
      let offset;
      if(maximum/speed<3){const t=clamp(elapsed/duration);offset=maximum*t*t*(3-2*t);}
      else if(elapsed<ramp)offset=acceleration(elapsed);
      else if(elapsed>duration-ramp)offset=maximum-acceleration(duration-elapsed);
      else offset=speed*(elapsed-ramp/2);
      offset=clamp(offset,0,maximum);
      if(returnAt){
        const t=clamp((now-returnAt)/1800),smooth=t*t*t*(t*(t*6-15)+10);
        offset=Math.min(returnFrom,maximum)*(1-smooth);
      }
      const base=Math.min(Math.floor(offset/rowHeight),Math.max(0,results.songs.length-1));
      if(base!==rowBase){
        // Recycle the leading row as the next overscan row. The other seven
        // keep their exact artwork/text resources as they pass through view.
        while(rowBase>=0&&rowBase<base){const row=rows.shift();rows.push(row);rowBase++;}
        while(rowBase>base){const row=rows.pop();rows.unshift(row);rowBase--;}
        rowBase=base;
        rows.forEach((row,i)=>{
          const n=base+i,song=results.songs[n];row.hidden=!song;
          if(!song){
            cancelGraphics(row);const canvas=row.querySelector('canvas');canvas.width=canvas.height=0;
            for(const element of row.querySelectorAll('.obs-text-viewport')){ui.release(element);layouts.delete(element);}
            delete row.dataset.index;return;
          }
          if(row.dataset.index===String(n))return;
          row.dataset.index=String(n);row.querySelector('.obs-chart-rank').textContent=String(n+1).padStart(2,'0');
          label(row.querySelector('.obs-chart-title'),song.title);label(row.querySelector('.obs-chart-artist'),song.artist);label(row.querySelector('.obs-chart-votes'),song.votes+' '+(song.votes===1?'vote':'votes'));
          cover(row.querySelector('canvas'),song.videoId,row._imageKey,192,false);
        });
      }
      rows.forEach((row,i)=>{row.style.transform='translateY('+(i*rowHeight-(offset-base*rowHeight))+'px)';});
      if(returnAt){if(now>=returnAt+1800)stage='list-hold';}
      else if(elapsed>=duration){if(!deadline)deadline=now+4000;if(now>=deadline){returnAt=now;returnFrom=maximum;}}
      else deadline=0;
    }
    async function fetchResults(){
      if(!active||!showing||requested===eventId||resultsAbort)return;
      const ticket=eventId,abort=new AbortController();resultsAbort=abort;const timeout=setTimeout(()=>abort.abort(),2000);
      try{
        const response=await fetch(origin+'/overlay-results',{cache:'no-store',credentials:'omit',signal:abort.signal});if(!response.ok)return;
        const raw=await response.text();if(raw.length>1024*1024)return;const value=JSON.parse(raw);
        if(ticket!==eventId||!active||!showing||value.version!==1||value.eventId!==eventId||!Array.isArray(value.songs)||value.songs.length>50)return;
        if(!value.songs.every(song=>song&&typeof song.title==='string'&&song.title.length<=2000&&typeof song.artist==='string'&&song.artist.length<=2000&&Number.isFinite(song.votes)&&Number.isFinite(song.duration)&&typeof song.videoId==='string'&&(!song.videoId||/^[A-Za-z0-9_-]{11}$/.test(song.videoId))))return;
        results=value;requested=eventId;
        if(stage==='entering'||stage==='thanks')prepareAwardSound(1);
      }catch(_error){/* Retry on the existing metadata poll, not a request loop. */}
      finally{clearTimeout(timeout);if(resultsAbort===abort)resultsAbort=null;}
    }
    function schedule(){if(!raf&&active&&showing&&!stopped)raf=requestAnimationFrame(tick);}
    function tick(now){
      raf=0;if(!active||!showing||stopped)return;
      if(Date.now()>=cutoff){finish();return;}
      if(!pendingTimer){
        if(stage==='thanks'&&now>=deadline){if(results?.songs.length)showWinner(0);else if(results)stage='thanks-final';}
        else if(stage==='winner'&&now>=deadline)exitThen(()=>showWinner(index+1));
        else if(stage==='list')updateList(now);
      }
      schedule();
    }
    function begin(event,expires){
      clearTimeout(retireTimer);if(retiring){releasePanel(retiring);retiring=null;}
      active=true;eventId=event.eventId;cutoff=expires;results=null;requested='';stage='entering';
      root=document.createElement('div');root.id='obs-showcase';root.className='obs-showcase-root';root.setAttribute('aria-label','Event celebration');document.body.appendChild(root);
      ui.animate(root,[{opacity:0},{opacity:1}],{duration:650,easing:ease});
      window.FuraticOBSForeground?.setEnabled(false);
      window.dispatchEvent(new Event('furatic:scenechange'));
      ui.animate(bar,[{opacity:1,transform:'none',filter:'none'},{opacity:0,transform:'translateY(-115%) scale(.985)',filter:'blur(5px)'}],{duration:650,easing:ease});
      pendingTimer=setTimeout(()=>{pendingTimer=0;if(!active)return;ui.suspend();if(showing)showThanks();},680);
      fetchResults();schedule();
    }
    function finish(restore=true){
      if(!active)return;active=false;clearTimeout(pendingTimer);pendingTimer=0;cancelAnimationFrame(raf);raf=0;
      resultsAbort?.abort();resultsAbort=null;releaseAwardSound();cancelAwardPhases();cancelGraphics();
      clearTimeout(retireTimer);if(retiring)releasePanel(retiring);
      retiring=root;root=null;if(retiring){
        const outgoing=retiring;outgoing.removeAttribute('id');
        ui.animate(outgoing,[{opacity:1},{opacity:0}],{duration:600,easing:ease});
        for(const panel of outgoing.children)ui.animate(panel,[{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-3vh) scale(.97)'}],{duration:600,easing:ease});
        retireTimer=setTimeout(()=>{releasePanel(outgoing);if(retiring===outgoing)retiring=null;retireTimer=0;},620);
      }
      rows=[];content=thanks=null;stage='none';results=null;requested='';
      if(!restore)return;
      window.FuraticOBSForeground?.setEnabled(true);ui.resume();
      window.dispatchEvent(new Event('furatic:scenechange'));
      ui.animate(bar,[{opacity:0,transform:'translateY(-105%)',filter:'blur(5px)'},{opacity:1,transform:'none',filter:'none'}],{duration:700,easing:ease});
    }
    const api={
      get active(){return active;},
      receive(value){
        if(stopped)return false;
        const event=value.event;
        if(value.mode!=='afterhours'){if(active)finish();return false;}
        if(!event||typeof event.eventId!=='string'||!Number.isFinite(event.endedAt)||event.endedAt<=0){if(active)finish();return false;}
        const saved=storage.read();const end=event.endedAt*1000;
        // Server time anchors the first observation. Browser storage can only
        // shorten an existing event's deadline, never restart its ten minutes.
        const expires=saved?.eventId===event.eventId&&Number.isFinite(saved.expiresAt)?Math.min(saved.expiresAt,end+600000):end+600000;
        if(saved?.eventId!==event.eventId||saved.expiresAt!==expires)storage.write({eventId:event.eventId,enteredAt:end,expiresAt:expires});
        if(Date.now()>=expires){if(active)finish();return false;}
        if(active&&eventId!==event.eventId)finish(false);
        if(!active)begin(event,expires);else{cutoff=Math.min(cutoff,expires);fetchResults();}
        return true;
      },
    };
    window.FuraticOBSPresentation=api;
    function visibility(event){
      if(event?.type==='obsSourceVisibleChanged'&&typeof event.detail?.visible==='boolean')obsShowing=event.detail.visible;
      showing=obsShowing&&!document.hidden;
      if(!active)return;
      if(!showing){cancelAnimationFrame(raf);raf=0;resultsAbort?.abort();clearTimeout(pendingTimer);pendingTimer=0;clearStage();root.hidden=true;stage='hidden';ui.suspend();}
      else if(Date.now()>=cutoff)finish();
      else{root.hidden=false;showThanks(true);fetchResults();schedule();}
    }
    let obsShowing=true;
    const resize=()=>{listRowSize=listHeight=0;if(stage==='list-hold')updateList(performance.now());};window.addEventListener('resize',resize);
    window.addEventListener('obsSourceVisibleChanged',visibility);document.addEventListener('visibilitychange',visibility);
    window.addEventListener('pagehide',()=>{
      stopped=true;active=false;clearTimeout(pendingTimer);clearTimeout(retireTimer);cancelAnimationFrame(raf);resultsAbort?.abort();clearStage();root?.remove();root=null;if(retiring)releasePanel(retiring);retiring=null;results=null;
      window.removeEventListener('obsSourceVisibleChanged',visibility);document.removeEventListener('visibilitychange',visibility);
      window.removeEventListener('resize',resize);
      delete window.FuraticOBSPresentation;
    },{once:true});
    if(ui.snapshot)api.receive(ui.snapshot);
  };
})();



