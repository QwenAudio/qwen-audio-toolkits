const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const context={Float32Array,Uint8Array,DataView,Math,globalThis:null};
context.globalThis=context;
vm.runInNewContext(fs.readFileSync('toolkits/ui-streaming.js','utf8'),context);
const R=context.ToolkitsStreaming.Resampler;
for(const rate of [16000,44100,48000]){
 const samples=Float32Array.from({length:rate},(_,i)=>Math.sin(i*.05));
 const a=new R(rate),b=new R(rate);
 const whole=Array.from(a.push(samples));let chunks=[];
 for(let i=0;i<samples.length;i+=4096)chunks.push(...b.push(samples.subarray(i,i+4096)));
 assert.equal(chunks.length,whole.length);
 assert(chunks.every((v,i)=>Math.abs(v-whole[i])<1e-5));
 assert(Math.abs(chunks.length-16000)<=1);
}
console.log('Streaming resampler preserves duration and continuity across chunk boundaries');

(async()=>{
 const calls=[];let processAudio,stopped=false,finished;
 const updates=[];
 const win={parent:null,addEventListener(){},removeEventListener(){}};win.parent=win;
 class AC{
   constructor(){this.sampleRate=48000;this.destination={}}
   resume(){return Promise.resolve()}
   close(){return Promise.resolve()}
   createMediaStreamSource(){return {connect(){},disconnect(){}}}
   createScriptProcessor(){return {set onaudioprocess(fn){processAudio=fn},connect(){},disconnect(){}}}
 }
 const media={getTracks:()=>[{stop(){stopped=true}}],getAudioTracks:()=>[{addEventListener(){}}]};
 const ctx={...context,window:win,AudioContext:AC,AbortSignal,Blob,Error,Promise,Date,setTimeout,clearTimeout,btoa:s=>Buffer.from(s,'binary').toString('base64'),
 navigator:{mediaDevices:{getUserMedia:async()=>media}},
 fetch:async(url,options)=>{
   calls.push({url,body:JSON.parse(options.body)});
   const result=url.endsWith('/start')?{id:'test'}:
     url.endsWith('/poll')?{state:'recording',outputs:['partial'],version:1}:
     url.endsWith('/finish')?{state:'completed',outputs:['final'],version:2}:{ok:true};
   return {ok:true,json:async()=>result};
 }};
 ctx.globalThis=ctx;
 vm.runInNewContext(fs.readFileSync('toolkits/ui-streaming.js','utf8'),ctx);
 const capture=await ctx.ToolkitsStreaming.capture({source:'microphone',onStart(){},onUpdate:r=>updates.push(r[0]),onFinish:r=>{finished=r},onError:e=>{throw e}});
 processAudio({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(.2)}});
 await new Promise(r=>setTimeout(r,10));
 assert(calls.some(c=>c.url.endsWith('/chunk')));
 assert(updates.includes('partial'));
 assert(!calls.some(c=>c.url.endsWith('/finish')));
 await capture.stop();
 assert(stopped);
 assert.equal(finished.outputs[0],'final');
 assert(finished.chunks.length>0);
 assert(calls.findIndex(c=>c.url.endsWith('/chunk'))<calls.findIndex(c=>c.url.endsWith('/finish')));
 console.log('Capture sends audio and renders interim results before stop; finish releases microphone and returns audio');
})().catch(error=>{console.error(error);process.exitCode=1});
