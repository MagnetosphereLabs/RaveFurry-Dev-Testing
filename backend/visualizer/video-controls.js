(() => {
  'use strict';
  const $=id=>document.getElementById(id),fields=['name','bind','port','latency','passphrase','senderIp'];
  let config=null,token='',socket=null,timer=0,volumeTimer=0,messageTimer=0,controller=null,writer=null,stopped=false,dirty=false,retry=0,writeChain=Promise.resolve(),editing=null,saving=false;
  const message=(text,error=false)=>{
    clearTimeout(messageTimer);messageTimer=0;
    const target=$('profile-dialog').open?$('profile-message'):$('message');
    for(const box of [$('message'),$('profile-message')]){box.textContent='';box.hidden=true;}
    target.textContent=text||'';target.hidden=!text;target.classList.toggle('error',error);
    if(text&&!error)messageTimer=setTimeout(()=>{target.hidden=true;target.textContent='';messageTimer=0;},4000);
  };
  function profileToForm(){
    const p=config.profiles[config.activeProfile];
    $('profiles').replaceChildren(...Object.entries(config.profiles).map(([key,p])=>{const o=document.createElement('option');o.value=key;o.textContent=p.name;return o;}));
    $('profiles').value=config.activeProfile;$('profiles').disabled=false;$('edit').disabled=false;
    $('add').disabled=Object.keys(config.profiles).length>=12;
    $('connection-summary').textContent='UDP '+p.port;
    if(!editing){for(const key of fields)$(key).value=p[key];dirty=false;}senderUrl();
  }
  function editProfile(create=false){
    if(!config||saving||create&&Object.keys(config.profiles).length>=12)return;
    const current=config.profiles[config.activeProfile];
    editing=create?'p'+Date.now():config.activeProfile;
    const p={...current};
    if(create){p.name='';p.senderIp='';p.passphrase=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');}
    for(const key of fields)$(key).value=p[key];dirty=false;
    $('profile-dialog-title').textContent=create?'Add a stream':'Edit connection';
    $('save-profile').textContent=create?'Add stream':'Save changes';
    $('remove').hidden=create;$('remove').disabled=Object.keys(config.profiles).length<2;
    $('passphrase').type='password';$('reveal').textContent='Show';$('reveal').setAttribute('aria-label','Show stream password');
    $('profile-form').querySelector('details').open=false;$('profile-message').hidden=true;
    $('profile-dialog').showModal();$('name').focus();if(!create)$('name').select();
  }
  function closeProfile(){if(saving)return;editing=null;dirty=false;$('profile-dialog').close();if(config)profileToForm();}
  function savingProfile(value){saving=value;for(const id of ['save-profile','remove','cancel-profile','close-profile'])$(id).disabled=value;if(!value)$('remove').disabled=Object.keys(config.profiles).length<2;}
  function formToProfile(){
    const p={};for(const key of fields)p[key]=['port','latency'].includes(key)?Number($(key).value):key==='passphrase'?$(key).value:$(key).value.trim();
    return p;
  }
  function senderUrl(){
    if(!config)return;const p=config.profiles[config.activeProfile],ip=$('destination').value.trim();
    const q=new URLSearchParams({mode:'caller',passphrase:p.passphrase,pbkeylen:'32'});
    $('sender-url').value=ip?'srt://'+ip+':'+p.port+'?'+q.toString():'';
    $('copy-url').disabled=!ip;
  }
  function render(value){
    if(value.token)token=value.token;if(value.config){config=value.config;profileToForm();}
    if(!config)return;
    for(const key of ['layout','enabled','volume','muted','locked','geometry'])if(value[key]!==undefined)config[key]=value[key];
    const media=value.media||{},format=media.width&&media.height?media.width+' × '+media.height:'';
    const titles={off:config.layout==='default'?'Music layout active':'Video receiver stopped',preparing:'Preparing video',starting:'Starting video',waiting:value.listenerReady?'Ready for incoming video':'Waiting for video',receiving:'Video connected',reconnecting:'Reconnecting',error:'Connection needs attention',setup_error:'Video setup needs attention'};
    $('status-title').textContent=titles[value.status]||'Connecting…';
    const details=value.status==='off'&&config.layout==='default'?'':['waiting','receiving'].includes(value.status)?[config.profiles[config.activeProfile].name,format].filter(Boolean).join(' · '):value.detail||'';
    $('status').textContent=[details,value.playbackError].filter(Boolean).join(' · ');$('status').hidden=!$('status').textContent;
    $('receiver-status').dataset.state=value.status||'off';
    $('retry').hidden=!['setup_error','error'].includes(value.status)||value.layout!=='video'||!value.enabled;
    $('retry').textContent=value.status==='setup_error'?'Retry setup':'Retry connection';
    $('firewall').disabled=value.runtimeReady===false||['preparing','starting'].includes(value.status);
    for(const b of document.querySelectorAll('[data-layout]')){b.classList.toggle('selected',b.dataset.layout===value.layout);b.setAttribute('aria-pressed',String(b.dataset.layout===value.layout));}
    $('muted').checked=value.muted;$('locked').checked=value.locked;
    if(document.activeElement!==$('volume'))$('volume').value=Math.round(value.volume*100);
    $('volume-value').textContent=Math.round(Number($('volume').value))+'%';
    if(value.windows!==undefined){$('firewall').hidden=!value.windows;$('firewall-section').hidden=!value.windows;}
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
      if(result.message)message(result.message);else{message('');render(result);}return true;
    }catch(e){if(!stopped)message(e.message||'Could not save settings. Check the local connection.',true);return false;}
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
    }catch(_){if(!current.signal.aborted){$('status-title').textContent='Controls disconnected';message('Reconnecting to local controls…',true);schedule();}}
    finally{if(controller===current)controller=null;}
  }
  function schedule(){if(!stopped&&!document.hidden&&!timer)timer=setTimeout(connect,Math.min(10000,1000*2**Math.min(retry++,4)));}
  function visibility(){
    clearTimeout(timer);timer=0;controller?.abort();
    if(document.hidden){if(socket){socket.onclose=null;socket.close();socket=null;}}
    else connect();
  }
  for(const b of document.querySelectorAll('[data-layout]'))b.onclick=()=>send({layout:b.dataset.layout,enabled:b.dataset.layout==='video'});
  for(const key of ['muted','locked'])$(key).onchange=()=>send({[key]:$(key).checked});
  for(const key of fields)$(key).oninput=()=>{dirty=true;};
  $('profile-form').onsubmit=async e=>{
    e.preventDefault();if(!config||!editing||saving)return;
    const next=JSON.parse(JSON.stringify(config));next.profiles[editing]=formToProfile();next.activeProfile=editing;
    savingProfile(true);const saved=await send(next);savingProfile(false);
    if(saved){closeProfile();message('Stream saved.');}
  };
  $('profile-form').addEventListener('invalid',e=>{const details=e.target.closest('details');if(details)details.open=true;},true);
  $('profiles').onchange=async()=>{if(!config)return;await send({activeProfile:$('profiles').value});profileToForm();};
  $('add').onclick=()=>editProfile(true);$('edit').onclick=()=>editProfile();
  $('cancel-profile').onclick=$('close-profile').onclick=closeProfile;
  $('profile-dialog').oncancel=e=>{if(saving)e.preventDefault();};
  $('profile-dialog').onclose=()=>{editing=null;dirty=false;$('profile-message').hidden=true;if(config)profileToForm();};
  $('remove').onclick=async()=>{
    if(!config||!editing||saving||Object.keys(config.profiles).length<2||!config.profiles[editing])return;
    if(!window.confirm('Delete the saved stream “'+config.profiles[editing].name+'”?'))return;
    const next=JSON.parse(JSON.stringify(config));delete next.profiles[editing];
    if(next.activeProfile===editing)next.activeProfile=Object.keys(next.profiles)[0];
    savingProfile(true);const saved=await send(next);savingProfile(false);
    if(saved){closeProfile();message('Stream deleted.');}
  };
  $('reveal').onclick=()=>{const hidden=$('passphrase').type==='password';$('passphrase').type=hidden?'text':'password';$('reveal').textContent=hidden?'Hide':'Show';$('reveal').setAttribute('aria-label',hidden?'Hide stream password':'Show stream password');};
  $('volume').oninput=()=>{const volume=Number($('volume').value)/100;$('volume-value').textContent=Math.round(volume*100)+'%';clearTimeout(volumeTimer);volumeTimer=setTimeout(()=>send({volume}),180);};
  $('volume').onchange=()=>{clearTimeout(volumeTimer);send({volume:Number($('volume').value)/100});};
  $('center').onclick=()=>send({geometry:{...(config?.geometry||{width:0}),x:.5,y:.5}});
  $('reset').onclick=()=>send({geometry:{x:.5,y:.5,width:0}});
  try{$('destination').value=localStorage.getItem('furatic.obs.senderDestination')||'';}catch(_){}
  $('destination').oninput=()=>{senderUrl();try{localStorage.setItem('furatic.obs.senderDestination',$('destination').value);}catch(_){}};
  $('firewall').onclick=async()=>{if(dirty){message('Save the receiver profile before requesting firewall permission.');return;}const b=$('firewall');b.disabled=true;message('Approve the Windows permission prompt on this PC.');await send({},'/video/firewall');b.disabled=false;};
  $('retry').onclick=async()=>{const b=$('retry');b.disabled=true;await send({},'/video/retry');b.disabled=false;};
  $('copy-url').onclick=async()=>{try{await navigator.clipboard.writeText($('sender-url').value);message('OBS server address copied.');}catch(_){$('sender-url').focus();$('sender-url').select();message('Press Ctrl+C to copy the selected address.');}};
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);clearTimeout(volumeTimer);clearTimeout(messageTimer);controller?.abort();writer?.abort();if(socket){socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null;socket.close();socket=null;}document.removeEventListener('visibilitychange',visibility);},{once:true});
  visibility();
})();

