/* A fixed PCM ring on the audio thread; no decoder and no main-thread scheduling. */
class FuraticPCM extends AudioWorkletProcessor {
  constructor(){
    super();this.capacity=48000;this.left=new Float32Array(this.capacity);this.right=new Float32Array(this.capacity);
    this.read=0;this.write=0;this.count=0;this.started=false;this.expected=-1;this.audioPort=null;this.dead=false;this.played=0;this.underruns=0;
    this.fraction=0;this.average=12000;this.rate=1;
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
    if((message.buffer.byteLength-20)%4||!Number.isSafeInteger(message.sample)||message.sample<0)return;
    const samples=new Int16Array(message.buffer,20),total=samples.length/2;
    if(total>16384)return;
    const gap=this.expected<0?0:message.sample-this.expected;
    const skip=Math.min(total,Math.max(0,-gap)),frames=total-skip;
    this.expected=Math.max(this.expected,message.sample+total);
    // Preserve already-buffered sound across a small missing/duplicate packet.
    // Only a real interruption (>250 ms) starts a fresh playback timeline.
    if(gap>12000){this.count=0;this.read=this.write;this.started=false;this.fraction=0;this.average=12000;this.rate=1;}
    const bridge=gap>0&&gap<=12000;
    // Trim excess age without emptying the ring and inserting another 250 ms
    // of silence. The ring remains fixed at one second of stereo samples.
    if(this.count+frames>24000){
      const drop=Math.min(this.count,this.count+frames-18000);
      this.read=(this.read+drop)%this.capacity;this.count-=drop;this.fraction=0;
    }
    const tail=(this.write+this.capacity-1)%this.capacity;
    const previousLeft=this.count?this.left[tail]:0,previousRight=this.count?this.right[tail]:0;
    for(let i=0;i<frames;i++){
      const blend=bridge?Math.min(1,(i+1)/128):1;
      this.left[this.write]=previousLeft*(1-blend)+samples[(i+skip)*2]/32768*blend;
      this.right[this.write]=previousRight*(1-blend)+samples[(i+skip)*2+1]/32768*blend;
      this.write=(this.write+1)%this.capacity;
    }
    this.count+=frames;
    if(typeof message.buffer.transfer==='function')message.buffer.transfer(0);
    this.audioPort?.postMessage({type:'accepted',sequence:message.sequence,queued:this.count,played:this.played,underruns:this.underruns});
  }
  process(_input,outputs){
    if(this.dead)return false;
    const out=outputs[0];if(!out?.length)return true;
    if(!this.started&&this.count>=12000){this.started=true;this.average=this.count;}
    const left=out[0],right=out[1]||left;
    // AudioContext requests 48 kHz; use its actual rate for machines that
    // override it rather than changing the pitch or the incoming timeline.
    // Sender and sound-device clocks drift even when both report 48 kHz.
    // A slow correction (at most 0.3%) prevents periodic drain/refill cycles;
    // packet timing jitter is averaged rather than followed packet by packet.
    if(this.started){
      this.average+=(this.count-this.average)*.002;
      const target=1+Math.max(-.003,Math.min(.003,(this.average-12000)/12000*.006));
      this.rate+=(target-this.rate)*.002;
    }
    const step=48000/sampleRate*this.rate;
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
