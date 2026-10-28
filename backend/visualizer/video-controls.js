(() => {
  'use strict';
  const $=id=>document.getElementById(id),fields=['name','bind','port','latency','passphrase','senderIp'];
  let config=null,token='',socket=null,timer=0,volumeTimer=0,controller=null,writer=null,stopped=false,dirty=false,retry=0,writeChain=Promise.resolve();
  const message=text=>{$('message').textContent=text||'';};
  function profileToForm(){
    const p=config.profiles[config.activeProfile];
    $('profiles').replaceChildren(...Object.entries(config.profiles).map(([key,p])=>{const o=document.createElement('option');o.value=key;o.textContent=p.name;return o;}));
    $('profiles').value=config.activeProfile;for(const key of fields)$(key).value=p[key];dirty=false;senderUrl();
    $('remove').disabled=Object.keys(config.profiles).length<2;
  }
  function formToProfile(){
    const p={};for(const key of fields)p[key]=['port','latency'].includes(key)?Number($(key).value):key==='passphrase'?$(key).value:$(key).value.trim();
    return p;
  }
  function senderUrl(){
    if(!config)return;const p=config.profiles[config.activeProfile],ip=$('destination').value.trim()||'STREAM_PC_IP';
    const q=new URLSearchParams({mode:'caller',passphrase:p.passphrase,pbkeylen:'32'});
    $('sender-url').value='srt://'+ip+':'+p.port+'?'+q.toString();
  }
  function render(value){
    if(value.token)token=value.token;if(value.config){config=value.config;if(!dirty)profileToForm();}
    if(!config)return;
    for(const key of ['layout','enabled','volume','muted','locked','geometry'])if(value[key]!==undefined)config[key]=value[key];
    const media=value.media||{},format=[media.videoCodec,media.audioCodec,media.width&&media.height?media.width+' × '+media.height:''].filter(Boolean).join(' · ');
    $('status').textContent=value.detail+(format?' · '+format:'')+(value.playbackError?' · '+value.playbackError:'');
    for(const b of document.querySelectorAll('[data-layout]')){b.classList.toggle('selected',b.dataset.layout===value.layout);b.setAttribute('aria-pressed',String(b.dataset.layout===value.layout));}
    $('enabled').checked=value.enabled;$('muted').checked=value.muted;$('locked').checked=value.locked;
    if(document.activeElement!==$('volume'))$('volume').value=Math.round(value.volume*100);
    $('volume-value').textContent=Math.round(Number($('volume').value))+'%';
    if(value.windows!==undefined)$('firewall').hidden=!value.windows;
    if(value.warning)message(value.warning);
  }
  function send(value,path='/video/settings'){
    if(value?.profiles&&value?.activeProfile)value={profiles:value.profiles,activeProfile:value.activeProfile};
    const operation=writeChain.then(()=>perform(value,path));writeChain=operation.catch(()=>{});return operation;
  }
  async function perform(value,path){
    if(stopped)return false;
    const current=writer=new AbortController();
    try{
      const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Furatic-Video-Token':token},body:JSON.stringify(value),signal:current.signal});
      if(!r.ok)throw new Error(await r.text());const result=await r.json();
      if(result.message)message(result.message);else{message('Saved');render(result);}return true;
    }catch(e){if(!stopped)message(e.message||'Could not save settings. Check the local connection.');return false;}
    finally{if(writer===current)writer=null;}
  }
  async function connect(){
    if(stopped||document.hidden)return;clearTimeout(timer);timer=0;controller?.abort();const current=controller=new AbortController();
    try{
      const r=await fetch('/video/state?controls=1',{cache:'no-store',signal:current.signal});if(!r.ok)throw new Error();
      const v=await r.json();if(stopped||current.signal.aborted)return;render(v);
      if(socket){socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;socket.close();}
      const ws=socket=new WebSocket('ws://'+location.host+'/video/events');
      ws.onopen=()=>{retry=0;};ws.onmessage=e=>{if(socket===ws&&!stopped)try{render(JSON.parse(e.data));}catch(_){}};ws.onerror=()=>ws.close();
      ws.onclose=()=>{if(socket===ws){socket=null;schedule();}};
    }catch(_){if(!current.signal.aborted){message('Local controls disconnected; reconnecting…');schedule();}}
    finally{if(controller===current)controller=null;}
  }
  function schedule(){if(!stopped&&!document.hidden&&!timer)timer=setTimeout(connect,Math.min(10000,1000*2**Math.min(retry++,4)));}
  function visibility(){
    clearTimeout(timer);timer=0;controller?.abort();
    if(document.hidden){if(socket){socket.onclose=null;socket.close();socket=null;}}
    else connect();
  }
  for(const b of document.querySelectorAll('[data-layout]'))b.onclick=()=>send({layout:b.dataset.layout});
  for(const key of ['enabled','muted','locked'])$(key).onchange=()=>send({[key]:$(key).checked});
  for(const key of fields)$(key).oninput=()=>{dirty=true;};
  $('profile-form').onsubmit=async e=>{e.preventDefault();if(!config)return;const next=JSON.parse(JSON.stringify(config));next.profiles[next.activeProfile]=formToProfile();if(await send(next)){dirty=false;profileToForm();}};
  $('profiles').onchange=async()=>{if(!config)return;const next=JSON.parse(JSON.stringify(config));next.profiles[next.activeProfile]=formToProfile();next.activeProfile=$('profiles').value;if(await send(next)){dirty=false;profileToForm();}};
  $('add').onclick=async()=>{if(!config)return;if(Object.keys(config.profiles).length>=12){message('Up to 12 receiver profiles are supported.');return;}const next=JSON.parse(JSON.stringify(config)),id='p'+Date.now();next.profiles[next.activeProfile]=formToProfile();next.profiles[id]={...next.profiles[next.activeProfile],name:'New profile',senderIp:''};next.activeProfile=id;if(await send(next)){dirty=false;profileToForm();}};
  $('remove').onclick=async()=>{if(!config||Object.keys(config.profiles).length<2)return;const next=JSON.parse(JSON.stringify(config));delete next.profiles[next.activeProfile];next.activeProfile=Object.keys(next.profiles)[0];if(await send(next)){dirty=false;profileToForm();}};
  $('reveal').onclick=()=>{const hidden=$('passphrase').type==='password';$('passphrase').type=hidden?'text':'password';$('reveal').textContent=hidden?'Hide':'Show';};
  $('volume').oninput=()=>{const volume=Number($('volume').value)/100;$('volume-value').textContent=Math.round(volume*100)+'%';clearTimeout(volumeTimer);volumeTimer=setTimeout(()=>send({volume}),180);};
  $('volume').onchange=()=>{clearTimeout(volumeTimer);send({volume:Number($('volume').value)/100});};
  $('center').onclick=()=>send({geometry:{...(config?.geometry||{width:0}),x:.5,y:.5}});
  $('reset').onclick=()=>send({geometry:{x:.5,y:.5,width:0}});
  try{$('destination').value=localStorage.getItem('furatic.obs.senderDestination')||'';}catch(_){}
  $('destination').oninput=()=>{senderUrl();try{localStorage.setItem('furatic.obs.senderDestination',$('destination').value);}catch(_){}};
  $('firewall').onclick=async()=>{if(dirty){message('Save the receiver profile before requesting firewall permission.');return;}const b=$('firewall');b.disabled=true;message('Approve the Windows permission prompt on this PC.');await send({},'/video/firewall');b.disabled=false;};
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);clearTimeout(volumeTimer);controller?.abort();writer?.abort();if(socket){socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;socket.close();socket=null;}document.removeEventListener('visibilitychange',visibility);},{once:true});
  visibility();
})();
