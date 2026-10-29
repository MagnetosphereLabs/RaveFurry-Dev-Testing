/* A fixed PCM ring on the audio thread; no decoder and no main-thread scheduling. */
class FuraticPCM extends AudioWorkletProcessor {
  constructor(){
    super();this.capacity=192000;this.target=60000;this.left=new Float32Array(this.capacity);this.right=new Float32Array(this.capacity);
    this.read=0;this.write=0;this.count=0;this.started=false;this.expected=-1;this.audioPort=null;this.dead=false;this.played=0;this.underruns=0;
    this.fraction=0;this.average=this.target;this.rate=1;this.discarded=0;this.discontinuities=0;
    this.reportFrames=0;this.primingDiscarded=0;
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
    if(this.dead||message.format!=='f32-planar'||!(message.buffer instanceof ArrayBuffer)||!message.buffer.byteLength)return;
    if(message.buffer.byteLength%8||!Number.isSafeInteger(message.sample)||message.sample<0)return;
    const samples=new Float32Array(message.buffer),total=samples.length/2;
    if(total>16384)return;
    const gap=this.expected<0?0:message.sample-this.expected;
    const skip=Math.min(total,Math.max(0,-gap)),frames=total-skip;
    this.expected=Math.max(this.expected,message.sample+total);
    // Source sample numbers are the common A/V timeline. Missing PCM must not
    // compress that timeline and permanently move sound ahead of the picture.
    let missing=Math.max(0,gap);
    if(missing>this.target){this.count=0;this.read=this.write;this.started=false;this.fraction=0;this.average=this.target;this.rate=1;this.discontinuities++;missing=0;}
    const bridge=missing>0;
    const excess=Math.max(0,this.count+missing+frames-this.capacity);
    if(excess){
      this.read=(this.read+excess)%this.capacity;this.count-=excess;this.fraction=0;
      if(this.started)this.discarded+=excess;else this.primingDiscarded+=excess;
    }
    for(let i=0;i<missing;i++){
      this.left[this.write]=this.right[this.write]=0;this.write=(this.write+1)%this.capacity;
    }
    this.count+=missing;
    const tail=(this.write+this.capacity-1)%this.capacity;
    const previousLeft=this.count?this.left[tail]:0,previousRight=this.count?this.right[tail]:0;
    const first=Math.min(frames,this.capacity-this.write);
    this.left.set(samples.subarray(skip,skip+first),this.write);
    this.right.set(samples.subarray(total+skip,total+skip+first),this.write);
    if(first<frames){
      this.left.set(samples.subarray(skip+first,total),0);
      this.right.set(samples.subarray(total+skip+first),0);
    }
    if(bridge)for(let i=0;i<Math.min(frames,128);i++){
      const at=(this.write+i)%this.capacity,blend=(i+1)/128;
      this.left[at]=previousLeft*(1-blend)+this.left[at]*blend;
      this.right[at]=previousRight*(1-blend)+this.right[at]*blend;
    }
    this.write=(this.write+frames)%this.capacity;
    this.count+=frames;
    if(typeof message.buffer.transfer==='function')message.buffer.transfer(0);
    this.audioPort?.postMessage({type:'accepted',sequence:message.sequence,queued:this.count,played:this.played,underruns:this.underruns,discarded:this.discarded,discontinuities:this.discontinuities,primingDiscarded:this.primingDiscarded});
  }
  process(_input,outputs){
    if(this.dead)return false;
    const out=outputs[0];if(!out?.length)return true;
    const left=out[0],right=out[1]||left;
    // Prime once from ordered PCM. Video follows this actual read position;
    // no wall-clock trimming or guessed independent video delay is needed.
    if(!this.started&&this.count>=this.target){this.started=true;this.average=this.count;this.rate=1;}
    // AudioContext requests 48 kHz; use its actual rate for machines that
    // override it rather than changing the pitch or the incoming timeline.
    // Sender and sound-device clocks drift even when both report 48 kHz.
    // A slow correction (at most 0.3%) prevents periodic drain/refill cycles;
    // packet timing jitter is averaged rather than followed packet by packet.
    if(this.started){
      this.average+=(this.count-this.average)*.002;
      const target=1+Math.max(-.003,Math.min(.003,(this.average-this.target)/this.target*.006));
      this.rate+=(target-this.rate)*.002;
    }
    const step=48000/sampleRate*this.rate;
    for(let i=0;i<left.length;i++){
      if(!this.started||this.count<2){left[i]=right[i]=0;if(this.started){this.underruns++;}this.started=false;continue;}
      const next=(this.read+1)%this.capacity,f=this.fraction;
      left[i]=this.left[this.read]*(1-f)+this.left[next]*f;
      right[i]=this.right[this.read]*(1-f)+this.right[next]*f;
      this.played++;
      this.fraction+=step;
      while(this.fraction>=1&&this.count){this.fraction--;this.read=(this.read+1)%this.capacity;this.count--;}
    }
    this.reportFrames+=left.length;
    if(this.reportFrames>=sampleRate*.025){
      this.reportFrames=0;
      this.audioPort?.postMessage({type:'clock',sample:this.expected<0?0:this.expected-this.count+this.fraction,
        rate:this.rate,playing:this.started,queued:this.count,played:this.played,underruns:this.underruns,
        discarded:this.discarded,discontinuities:this.discontinuities,primingDiscarded:this.primingDiscarded});
    }
    return true;
  }
}
registerProcessor('furatic-pcm',FuraticPCM);
