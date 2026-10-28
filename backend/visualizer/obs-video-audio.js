/* A fixed PCM ring on the audio thread; no decoder and no main-thread scheduling. */
class FuraticPCM extends AudioWorkletProcessor {
  constructor(){
    super();this.capacity=48000;this.left=new Float32Array(this.capacity);this.right=new Float32Array(this.capacity);
    this.read=0;this.write=0;this.count=0;this.started=false;this.expected=-1;this.audioPort=null;this.dead=false;this.played=0;this.underruns=0;
    this.port.onmessage=e=>{
      if(e.data.type==='port'){
        this.audioPort?.close();this.audioPort=e.data.port;
        this.audioPort.onmessage=event=>this.push(event.data);this.audioPort.start();
      }else if(e.data.type==='stop'){
        this.dead=true;this.audioPort?.close();this.audioPort=null;this.port.close();
      }
    };
  }
  push(message){
    if(this.dead||!(message.buffer instanceof ArrayBuffer)||message.buffer.byteLength<20)return;
    const samples=new Int16Array(message.buffer,20),frames=samples.length/2;
    if(frames>16384)return;
    if(this.expected!==message.sample){this.count=0;this.read=this.write;this.started=false;this.fraction=0;}
    this.expected=message.sample+frames;
    // Keep ~250 ms of jitter protection. Old audio is discarded, never replayed
    // faster after a blocked worker or an OS scheduling interruption.
    if(this.count+frames>24000){this.count=0;this.read=this.write;this.started=false;}
    for(let i=0;i<frames;i++){
      this.left[this.write]=samples[i*2]/32768;this.right[this.write]=samples[i*2+1]/32768;
      this.write=(this.write+1)%this.capacity;
    }
    this.count+=frames;
    this.audioPort?.postMessage({type:'accepted',sequence:message.sequence,queued:this.count,played:this.played,underruns:this.underruns});
  }
  process(_input,outputs){
    if(this.dead)return false;
    const out=outputs[0];if(!out?.length)return true;
    if(!this.started&&this.count>=12000)this.started=true;
    const left=out[0],right=out[1]||left;
    // AudioContext requests 48 kHz; use its actual rate for machines that
    // override it rather than changing the pitch or the incoming timeline.
    const step=48000/sampleRate;
    this.fraction=this.fraction||0;
    for(let i=0;i<left.length;i++){
      if(!this.started||this.count<2){left[i]=right[i]=0;if(this.started)this.underruns++;this.started=false;continue;}
      const next=(this.read+1)%this.capacity,f=this.fraction;
      left[i]=this.left[this.read]*(1-f)+this.left[next]*f;
      right[i]=this.right[this.read]*(1-f)+this.right[next]*f;
      this.played++;
      this.fraction+=step;
      while(this.fraction>=1&&this.count){this.fraction--;this.read=(this.read+1)%this.capacity;this.count--;}
    }
    return true;
  }
}
registerProcessor('furatic-pcm',FuraticPCM);
