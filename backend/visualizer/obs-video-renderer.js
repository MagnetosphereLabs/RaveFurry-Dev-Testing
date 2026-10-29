/* Explicitly closed VideoFrames, one fixed 720p texture, and the scene GPU fence. */
(() => {
  'use strict';
  window.FuraticOBSCreateVideoRenderer=function(options){
    let dead=false,worker=null,context=null,node=null,gain=null,channel=null,workerURL=null,closing=null;
    let pending=null,ahead=null,submitted=null,graphics=null,first=true,received=0,drawn=0,credited=0,lastSequence=0,audioStatus=null,graphicsUnavailable=false;
    const deferredCredits=[];
    const vertex=`#version 300 es
      precision highp float;uniform vec2 u_resolution;uniform vec4 u_rect;out vec2 uv;
      void main(){vec2 p=vec2(gl_VertexID==1||gl_VertexID==3?1.:0.,gl_VertexID>=2?1.:0.);
      vec2 local=p*(u_rect.zw+vec2(128.,152.))-vec2(64.);uv=local/u_rect.zw;
      vec2 pixel=u_rect.xy+local;gl_Position=vec4(pixel.x/u_resolution.x*2.-1.,1.-pixel.y/u_resolution.y*2.,0.,1.);}`;
    const fragment=`#version 300 es
      precision highp float;in vec2 uv;uniform sampler2D u_texture;
      uniform vec4 u_crop;uniform vec2 u_size;uniform float u_alpha;out vec4 color;
      float rounded(vec2 p,float radius){p=abs(p)-(u_size*.5-radius);return length(max(p,0.))+min(max(p.x,p.y),0.)-radius;}
      void main(){vec2 local=uv*u_size-u_size*.5;float radius=min(18.,min(u_size.x,u_size.y)*.5);
      float d=rounded(local,radius),edge=max(.5,fwidth(d));float cover=1.-smoothstep(-edge,edge,d);
      float border=cover*smoothstep(-1.-edge,-1.+edge,d);
      float sd=max(0.,rounded(local-vec2(0.,12.),radius)),shadow=.2*exp(-sd*sd/512.);
      float alpha=cover+(1.-cover)*shadow;vec3 rgb=texture(u_texture,u_crop.xy+clamp(uv,0.,1.)*u_crop.zw).rgb;
      color=vec4(mix(rgb,vec3(1.),border*.188)*cover/max(alpha,.0001),u_alpha*alpha);}`;
    function ack(sequence){if(worker&&!dead){worker.postMessage({type:'ack',sequence});credited++;}}
    function destroy(old,valid=true){
      if(old&&valid){const gl=old.gl;gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,null);gl.bindVertexArray(null);gl.useProgram(null);
        for(const texture of old.textures)gl.deleteTexture(texture);gl.deleteVertexArray(old.vao);gl.deleteProgram(old.program);gl.flush();}
    }
    function free(valid=true){const old=graphics;graphics=null;destroy(old,valid);}
    function retireGraphics(){
      const old=graphics;graphics=null;if(!old)return Promise.resolve();
      const gl=old.gl;if(gl.isContextLost())return Promise.resolve();
      // Retire the last native upload before another decoder/texture is created.
      // This runs only at shutdown, never blocks the render or audio threads.
      const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();
      return new Promise(resolve=>{
        const poll=()=>{
          if(gl.isContextLost()){resolve();return;}
          const result=fence?gl.clientWaitSync(fence,0,0):gl.WAIT_FAILED;
          if(result===gl.TIMEOUT_EXPIRED){setTimeout(poll,16);return;}
          if(fence)gl.deleteSync(fence);destroy(old);resolve();
        };poll();
      });
    }
    function make(gl){
      const shaders=[],textures=[];let program=null,vao=null;
      try{
        for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
          const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
          if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('Video shader compilation failed');
        }
        program=gl.createProgram();for(const shader of shaders)gl.attachShader(program,shader);gl.linkProgram(program);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Video shader link failed');
        for(const shader of shaders)gl.detachShader(program,shader);
        vao=gl.createVertexArray();if(!vao)throw new Error('Video geometry allocation failed');
        for(const [width,height] of [[1280,720]]){
          const texture=gl.createTexture();if(!texture)throw new Error('Video texture allocation failed');textures.push(texture);
          gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
          gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,width,height);
        }
        const at=name=>gl.getUniformLocation(program,name);
        graphics={gl,program,vao,textures,ready:false,resolution:at('u_resolution'),rect:at('u_rect'),crop:at('u_crop'),size:at('u_size'),alpha:at('u_alpha'),samplers:['u_texture'].map(at)};
      }catch(error){for(const texture of textures)gl.deleteTexture(texture);if(vao)gl.deleteVertexArray(vao);if(program)gl.deleteProgram(program);throw error;}
      finally{for(const shader of shaders)gl.deleteShader(shader);}
    }
    const api={
      async start(){
        const Audio=window.AudioContext||window.webkitAudioContext;
        if(!Audio)throw new Error('This OBS browser lacks Web Audio support');
        context=new Audio({sampleRate:48000,latencyHint:'interactive'});
        await context.audioWorklet.addModule(options.origin+'/obs-video-audio.js?v=1');if(dead)return;
        node=new AudioWorkletNode(context,'furatic-pcm',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
        gain=context.createGain();node.connect(gain);gain.connect(context.destination);api.audio(options.volume,options.muted);
        channel=new MessageChannel();node.port.postMessage({type:'port',port:channel.port1},[channel.port1]);
        // A small classic-worker wrapper also supports an OBS local-file page.
        workerURL=URL.createObjectURL(new Blob(['importScripts('+JSON.stringify(options.origin+'/obs-video-transport.js?v=1')+');'],{type:'text/javascript'}));
        worker=new Worker(workerURL);worker.onmessage=event=>{
          const message=event.data;if(dead){message.frame?.close();return;}
          if(message.type==='frame'){
            if(graphicsUnavailable){message.frame?.close();deferredCredits.push(message.sequence);return;}
            if(pending&&ahead){message.frame?.close();options.onError('Video exceeded its frame credit');return;}
            if(!message.frame||message.frame.displayWidth!==1280||message.frame.displayHeight!==720){message.frame?.close();options.onError('Invalid 720p video frame');return;}
            if(pending)ahead=message;else pending=message;received++;lastSequence=message.sequence;
          }else if(message.type==='audio-status')audioStatus=message.value;
          else if(message.type==='closed'||message.type==='error')options.onError(message.message||'Reconnecting…',message.fatal||false);
        };
        worker.onerror=()=>{if(!dead)options.onError('Video transport stopped');};
        worker.postMessage({type:'port',port:channel.port2},[channel.port2]);worker.postMessage({type:'connect',url:options.url});
        await context.resume();
      },
      resume(){if(!dead)context?.resume().catch(()=>{});},
      audio(volume,muted){if(gain)gain.gain.setValueAtTime(muted?0:volume,context.currentTime);},
      draw(gl,w,h,rect,crop,alpha){
        if(graphicsUnavailable){graphicsUnavailable=false;for(const sequence of deferredCredits)ack(sequence);deferredCredits.length=0;}
        if(submitted!==null)return;
        if(ahead){pending.frame.close();ack(pending.sequence);pending=ahead;ahead=null;} // The enclosing scene fence owns this GPU submission.
        if(pending&&Date.now()-pending.arrivedAt>300){const sequence=pending.sequence;pending.frame.close();pending=null;ack(sequence);}
        if(dead||(!pending&&!graphics?.ready))return;
        if(graphics?.gl!==gl)free();if(!graphics)make(gl);
        const r=graphics;gl.useProgram(r.program);gl.bindVertexArray(r.vao);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        const frame=pending;pending=null;
        try{
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,r.textures[0]);gl.uniform1i(r.samplers[0],0);
          if(frame)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,frame.frame);
          if(frame){submitted=frame.sequence;r.ready=true;drawn++;ack(frame.sequence);if(first){first=false;options.onFrame();}}
          gl.uniform2f(r.resolution,w,h);gl.uniform4fv(r.rect,rect);gl.uniform4fv(r.crop,crop);gl.uniform2f(r.size,rect[2],rect[3]);gl.uniform1f(r.alpha,alpha);
          gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
        }finally{frame?.frame.close();gl.disable(gl.BLEND);gl.bindVertexArray(null);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,null);gl.useProgram(null);}
      },
      complete(){submitted=null;},
      graphicsLost(valid=false){
        graphicsUnavailable=true;
        for(const frame of [pending,ahead])if(frame){frame.frame.close();deferredCredits.push(frame.sequence);}
        pending=ahead=null;free(valid);api.complete();
      },
      close(){
        if(closing)return closing;dead=true;pending?.frame.close();ahead?.frame.close();pending=ahead=null;submitted=null;deferredCredits.length=0;
        const releases=[retireGraphics()];
        if(worker){
          const old=worker;worker=null;let deadline=0;
          releases.push(new Promise(resolve=>{
            const terminate=()=>{clearTimeout(deadline);old.onmessage=old.onerror=null;old.terminate();resolve();};
            old.onmessage=e=>{e.data.frame?.close();if(e.data.type==='stopped')terminate();};old.onerror=terminate;
            old.postMessage({type:'stop'});deadline=setTimeout(terminate,250);
          }));
        }
        if(workerURL){URL.revokeObjectURL(workerURL);workerURL=null;}
        if(node){node.port.postMessage({type:'stop'});node.port.close();node.disconnect();node=null;}
        gain?.disconnect();gain=null;channel?.port1.close();channel?.port2.close();channel=null;
        if(context){releases.push(context.close().catch(()=>{}));context=null;}
        closing=Promise.all(releases).then(()=>{});return closing;
      },
      get stats(){return {received,drawn,credited,lastSequence,pending:(pending?1:0)+(ahead?1:0),inflight:submitted===null?0:1,textures:graphics?1:0,audioState:context?.state||'closed',audio:audioStatus};}
    };
    return api;
  };
})();
