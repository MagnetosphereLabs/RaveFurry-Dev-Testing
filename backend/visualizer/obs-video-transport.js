/* Networking stays off the UI thread. Video requires explicit renderer buffer credit. */
let socket=null,audioPort=null,audioCredit=new Set(),stopped=false,audioReports=0;
const audioPending=[];let audioPendingFrames=0;
const PIXEL_BYTES=1280*720*3/2;
let buffers=[],displayOutstanding=new Set(),heldAck=null;
function sendAck(sequence){if(socket?.readyState===1)socket.send(JSON.stringify({ack:sequence}));}
function picture(buffer,sequence){
  // Only loopback pixels enter this worker. No VideoDecoder, VideoFrame,
  // shared GPU image, readback context or per-session decoder texture pool.
  if(buffer.byteLength!==20+PIXEL_BYTES||displayOutstanding.size>=2){fail('Video transport exceeded its pixel bound',true);return;}
  if(!buffers.length&&!displayOutstanding.size)buffers=[new ArrayBuffer(PIXEL_BYTES),new ArrayBuffer(PIXEL_BYTES)];
  const pixels=buffers.pop();
  if(!pixels){fail('Video pixel pool exhausted',true);return;}
  new Uint8Array(pixels).set(new Uint8Array(buffer,20));
  displayOutstanding.add(sequence);
  self.postMessage({type:'pixels',sequence,arrivedAt:Date.now(),pixelFormat:'I420',buffer:pixels},[pixels]);
  // Fill at most two display slots. Until one is recycled, withhold network
  // credit too, so a stalled UI cannot accumulate incoming raw frame packets.
  if(displayOutstanding.size<2)sendAck(sequence);else heldAck=sequence;
}
function fail(message,fatal=false){stop();self.postMessage({type:'error',message,fatal});}
function audio(message){
  if(!audioPort)return;
  // Audio is ordered, unlike disposable video frames. A scheduling burst must
  // not replace the middle of a sentence with only its newest packet.
  audioPending.push(message);audioPendingFrames+=(message.buffer.byteLength-20)/4;
  while(audioPending.length>96||audioPendingFrames>96000){
    const old=audioPending.shift();audioPendingFrames-=(old.buffer.byteLength-20)/4;
    if(typeof old.buffer.transfer==='function')old.buffer.transfer(0);
  }
  drainAudio();
}
function drainAudio(){
  while(audioPort&&audioCredit.size<8&&audioPending.length){
    const message=audioPending.shift();audioPendingFrames-=(message.buffer.byteLength-20)/4;
    audioCredit.add(message.sequence);audioPort.postMessage(message,[message.buffer]);
  }
}
function stop(){
  stopped=true;displayOutstanding.clear();buffers.length=0;heldAck=null;audioPending.length=0;audioPendingFrames=0;audioCredit.clear();if(audioPort){audioPort.onmessage=null;audioPort.close();audioPort=null;}
  if(socket){socket.onopen=socket.onmessage=socket.onerror=socket.onclose=null;socket.close();socket=null;}
}
self.onmessage=event=>{
  const message=event.data;
  if(stopped){if(message.type==='stop'){self.postMessage({type:'stopped'});self.close();}return;}
  if(message.type==='port'){
    audioPort=message.port;audioPort.onmessage=e=>{
      if(e.data.type!=='accepted')return;audioCredit.delete(e.data.sequence);
      if(++audioReports%50===0)self.postMessage({type:'audio-status',value:e.data});
      drainAudio();
    };audioPort.start();
  }else if(message.type==='connect'&&!socket&&!stopped){
    const ws=socket=new WebSocket(message.url);ws.binaryType='arraybuffer';
    ws.onmessage=e=>{
      if(stopped)return;const buffer=e.data;if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<20)return;
      const bytes=new Uint8Array(buffer,0,4);if(bytes[0]!==70||bytes[1]!==85||bytes[2]!==86||bytes[3]!==51){fail('Video protocol changed. Restart Furatic and refresh the OBS browser source.',true);return;}
      const view=new DataView(buffer),kind=view.getUint8(4),sequence=view.getUint32(8,true);
      if(kind===1){
        try{picture(buffer,sequence);}catch(error){fail(error.message||'Video pixel transfer stopped');}
        finally{if(buffer.byteLength&&typeof buffer.transfer==='function')buffer.transfer(0);}
      }else if(kind===2&&buffer.byteLength<=65556&&(buffer.byteLength-20)%4===0){
        const sample=Number(view.getBigUint64(12,true));audio({sequence,sample,buffer});
      }
    };
    ws.onerror=()=>ws.close();ws.onclose=()=>{if(!stopped){stop();self.postMessage({type:'closed'});}};
  }else if(message.type==='ack'&&displayOutstanding.has(message.sequence)){
    displayOutstanding.delete(message.sequence);
    if(!(message.buffer instanceof ArrayBuffer)||message.buffer.byteLength!==PIXEL_BYTES||buffers.length>=2){fail('Invalid recycled video buffer',true);return;}
    buffers.push(message.buffer);
    if(heldAck!==null){const sequence=heldAck;heldAck=null;sendAck(sequence);}
  }else if(message.type==='stop'){stop();self.postMessage({type:'stopped'});self.close();}
};
