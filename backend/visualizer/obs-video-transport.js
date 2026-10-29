/* Networking stays off the UI thread. Video requires explicit renderer buffer credit. */
let socket=null,audioPort=null,audioCredit=new Set(),latestAudio=null,stopped=false,audioReports=0;
let decoder=null,decoding=null,prefetch=null,displayOutstanding=new Set(),configured=false,configuring=false;
const Y=1280*720,UV=Y/4;
let buffers=[],pixelFormat=null,copyTask=null,nativeFrame=null,chroma=null;
function sendAck(sequence){if(socket?.readyState===1)socket.send(JSON.stringify({ack:sequence}));}
function codecFrom(buffer){
  const bytes=new Uint8Array(buffer,20);for(let i=0;i<Math.min(bytes.length-4,512);i++){
    let start=-1;if(bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===1)start=i+3;
    else if(bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===0&&bytes[i+3]===1)start=i+4;
    if(start>=0&&(bytes[start]&31)===7)return 'avc1.'+[bytes[start+1],bytes[start+2],bytes[start+3]].map(n=>n.toString(16).padStart(2,'0')).join('');
  }throw new Error('Video frame is missing its independent H.264 header');
}
async function pump(){
  if(stopped||displayOutstanding.size>=2||decoding||copyTask||!prefetch||configuring)return;
  const message=prefetch;prefetch=null;
  if(Date.now()-message.arrivedAt>300){sendAck(message.sequence);return;}
  if(!configured){
    configuring=true;
    try{
      if(typeof VideoDecoder!=='function')throw new Error('This OBS browser lacks WebCodecs video support');
      let config={codec:codecFrom(message.buffer),codedWidth:1280,codedHeight:720,optimizeForLatency:true,hardwareAcceleration:'prefer-hardware'};
      let result=await VideoDecoder.isConfigSupported(config);
      if(!result.supported){config.hardwareAcceleration='no-preference';result=await VideoDecoder.isConfigSupported(config);}
      if(!result.supported)throw new Error('This OBS browser cannot decode the bounded 720p format');
      if(stopped)return;
      decoder=new VideoDecoder({output(frame){
        const current=decoding;decoding=null;
        if(stopped||!current||copyTask){frame.close();return;}
        nativeFrame=frame;
        // Keep GPU surfaces inside the decoder worker. Only two recycled CPU
        // buffers cross threads; WebGL never imports a native VideoFrame.
        copyTask=copyPicture(frame,current).finally(()=>{copyTask=null;if(!stopped)pump();});
      },error(error){fail(error.message||'Video decoder stopped');}});
      decoder.configure(result.config);configured=true;
    }catch(error){fail(error.message,true);return;}
    finally{configuring=false;}
  }
  if(stopped)return;decoding=message;
  try{decoder.decode(new EncodedVideoChunk({type:'key',timestamp:Number(new DataView(message.buffer).getBigUint64(12,true)),data:new Uint8Array(message.buffer,20)}));}
  catch(error){decoding=null;fail(error.message);}
}
function releaseFrame(frame){if(nativeFrame===frame){frame.close();nativeFrame=null;}}
async function copyPicture(frame,current){
  let buffer=null;
  try{
    if(frame.displayWidth!==1280||frame.displayHeight!==720)throw new Error('Decoder exceeded 720p');
    const planar=frame.format==='I420'||frame.format==='NV12';
    if(!pixelFormat){pixelFormat=planar?'I420':'RGBA';buffers=[new ArrayBuffer(planar?Y+2*UV:Y*4),new ArrayBuffer(planar?Y+2*UV:Y*4)];}
    if(pixelFormat==='I420'&&!planar)throw new Error('Decoder changed pixel format');
    buffer=buffers.pop();if(!buffer)throw new Error('Video pixel pool exhausted');
    const layout=pixelFormat==='RGBA'?[{offset:0,stride:5120}]:frame.format==='NV12'?[{offset:0,stride:1280},{offset:Y,stride:1280}]:[{offset:0,stride:1280},{offset:Y,stride:640},{offset:Y+UV,stride:640}];
    await frame.copyTo(buffer,{layout,...(pixelFormat==='RGBA'?{format:'RGBA'}:{})});
    releaseFrame(frame);
    if(stopped)return;
    if(layout.length===2){
      if(!chroma)chroma=new Uint8Array(2*UV);const bytes=new Uint8Array(buffer);chroma.set(bytes.subarray(Y));
      for(let i=0;i<UV;i++){bytes[Y+i]=chroma[i*2];bytes[Y+UV+i]=chroma[i*2+1];}
    }
    displayOutstanding.add(current.sequence);
    self.postMessage({type:'pixels',sequence:current.sequence,arrivedAt:current.arrivedAt,pixelFormat,buffer},[buffer]);buffer=null;
    sendAck(current.sequence);
  }catch(error){if(!stopped)fail(error.message||'Video pixel transfer stopped',true);}
  finally{releaseFrame(frame);if(buffer&&!stopped)buffers.push(buffer);}
}
function fail(message,fatal=false){stop();self.postMessage({type:'error',message,fatal});}
function audio(message){
  if(!audioPort)return;
  if(audioCredit.size>=8){latestAudio=message;return;}
  audioCredit.add(message.sequence);audioPort.postMessage(message,[message.buffer]);
}
function stop(){
  stopped=true;displayOutstanding.clear();buffers.length=0;chroma=null;nativeFrame?.close();nativeFrame=null;latestAudio=prefetch=decoding=null;try{decoder?.close();}catch(_){}decoder=null;configured=false;audioCredit.clear();audioPort?.close();audioPort=null;
  if(socket){socket.onopen=socket.onmessage=socket.onerror=socket.onclose=null;socket.close();socket=null;}
}
self.onmessage=event=>{
  const message=event.data;
  if(message.type==='port'){
    audioPort=message.port;audioPort.onmessage=e=>{
      if(e.data.type!=='accepted')return;audioCredit.delete(e.data.sequence);
      if(++audioReports%50===0)self.postMessage({type:'audio-status',value:e.data});
      if(latestAudio){const value=latestAudio;latestAudio=null;audio(value);}
    };audioPort.start();
  }else if(message.type==='connect'&&!socket&&!stopped){
    const ws=socket=new WebSocket(message.url);ws.binaryType='arraybuffer';
    ws.onmessage=e=>{
      const buffer=e.data;if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<20)return;
      const bytes=new Uint8Array(buffer,0,4);if(bytes[0]!==70||bytes[1]!==85||bytes[2]!==86||bytes[3]!==50){stop();return;}
      const view=new DataView(buffer),kind=view.getUint8(4),sequence=view.getUint32(8,true);
      if(kind===1){
        if(buffer.byteLength>2097172||prefetch){fail('Video transport exceeded its frame credit');return;}
        prefetch={sequence,arrivedAt:Date.now(),buffer};pump();
      }else if(kind===2&&buffer.byteLength<=65556&&(buffer.byteLength-20)%4===0){
        const sample=Number(view.getBigUint64(12,true));audio({sequence,sample,buffer});
      }
    };
    ws.onerror=()=>ws.close();ws.onclose=()=>{if(!stopped){stop();self.postMessage({type:'closed'});}};
  }else if(message.type==='ack'&&displayOutstanding.has(message.sequence)){
    displayOutstanding.delete(message.sequence);
    const bytes=pixelFormat==='I420'?Y+2*UV:Y*4;
    if(!(message.buffer instanceof ArrayBuffer)||message.buffer.byteLength!==bytes||buffers.length>=2){fail('Invalid recycled video buffer',true);return;}
    buffers.push(message.buffer);pump();
  }else if(message.type==='stop'){stop();Promise.resolve(copyTask).finally(()=>{self.postMessage({type:'stopped'});self.close();});}
};
