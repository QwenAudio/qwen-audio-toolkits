const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
class E { constructor(tag='div'){this.tag=tag;this.dataset={};this.children=[];this.hidden=false;this.classList={add(){},remove(){},toggle(){}};} append(x){this.children.push(x)} replaceChildren(){this.children=[]} addEventListener(){} setAttribute(){} querySelectorAll(){return []} querySelector(){return null} click(){this.onclick?.()} remove(){} }
const ids=Object.fromEntries(['history','result-detail','detail-content','close-detail','run','clear','inputs','status'].map(k=>[k,new E()]));
const source=fs.readFileSync('toolkits/ui.js','utf8');
const end=source.indexOf('\n  try {\n    const response = await fetch("history")');
let reset=0,calls=0;
const context={console,structuredClone,Map,Array,JSON,Error,atob,running:false,$:id=>ids[id],element:(t,p,text)=>{const e=new E(t);e.textContent=text;p.append(e);return e},render:(p,c,v)=>{const e=new E();e.value=v;p.append(e);return e},document:{createElement:tag=>new E(tag),querySelector:()=>new E(),querySelectorAll:()=>[]},components:[{kind:'audio',label:'Audio'}],schema:{title:'ASR',outputs:[{kind:'text'},{kind:'table'}]},mounts:[{classList:{contains:()=>true}}],audioResets:new Map([[0,()=>reset++]]),inputValues:[null],pack:x=>x,status:()=>{},fetch:async(url)=>{if(url==='history')return {ok:true};calls++;return {ok:true,json:async()=>({outputs:['recognized',[[0,1,'recognized']]]})}}};
const hostListeners=new Map(),hostParent={postMessage(){}};
context.window={parent:hostParent,addEventListener(type,listener){const listeners=hostListeners.get(type)||new Set();listeners.add(listener);hostListeners.set(type,listeners)},removeEventListener(type,listener){hostListeners.get(type)?.delete(listener)},dispatchMessage(event){for(const listener of hostListeners.get('message')||[])listener(event)}};
const hostBootstrap=source.slice(source.indexOf('const toolkitsHost = (() => {'),source.indexOf('\nconst status = '));
vm.createContext(context);vm.runInContext(fs.readFileSync("toolkits/ui-content.js","utf8"),context);vm.runInContext(hostBootstrap,context);context.window.dispatchMessage({source:hostParent,origin:'https://toolkits-host.test',data:{type:'toolkits-host-ready'}});vm.runInContext(source.slice(source.indexOf('  let captionTarget = null;'),end),context);
(async()=>{await context.submit([{name:'one.wav',data:'AAAA'}]);assert.equal(calls,1);assert.equal(reset,1);assert.equal(ids.history.children.length,1);assert.equal(ids['result-detail'].children.length,0); context.showDetail(context.ToolkitsContent.content({kind:"text"},"recognized")); assert.equal(ids['result-detail'].hidden,false);assert.equal(ids.history.children[0].children.length,2);await context.submit([{name:'two.wav',data:'BBBB'}]);assert.equal(ids.history.children.length,2);assert.equal(reset,2);ids['close-detail'].click();assert.equal(ids['result-detail'].hidden,true);console.log('Conversation: paired turns, audio reset, details and close passed')})().catch(e=>{console.error(e);process.exit(1)});
const content=context.ToolkitsContent;
for (const [input,output] of [['audio','text'],['text','audio'],['text','text'],['audio','audio']]) {
  const value=kind=>kind==='audio'?{name:'test.wav',data:'AAAA'}:'hello';
  for(const [role,kind] of [['user',input],['assistant',output]]) {
    const message=content.message(role,[{kind,label:'content'}],[value(kind)]);
    assert.equal(message.content[0].kind,kind);
    content.render(new E(),message.content[0]);
  }
}
const block=content.content({kind:'table',columns:['value']},[['<script>']]);
const summary=content.render(new E(),block,'message');
assert.equal(summary.hidden,true);
assert.equal(summary.children.length,0);
const detail=content.render(new E(),block,'detail');
assert.equal(detail.children[0].children[0].tag,'table');
assert.throws(()=>content.message('invalid',[],[]));
console.log('Shared content: ASR, TTS, text, S2S and table detail passed');

const proxiedInputs = new Proxy([{main: 'test', additional: [1]}], {});
const snapshotExpression = source.match(/\$\("run"\)\.onclick = \(\) => submit\((.+)\);/)[1];
const snapshot = vm.runInNewContext(snapshotExpression, { inputValues: proxiedInputs, structuredClone, Array });
assert.deepEqual(snapshot, [{main: 'test', additional: [1]}]);
proxiedInputs[0].main = 'changed';
assert.equal(snapshot[0].main, 'test');
console.log('Proxy input snapshot is cloneable and independent');

assert.deepEqual(Array.from(context.ToolkitsContent.waveformPeaks([[0, 0, 0, 0]], 2)), [0, 0]);
assert.deepEqual(Array.from(context.ToolkitsContent.waveformPeaks([[0, -0.8, 0.2, 0], [1, 0, -0.5, 0]], 2)), [1, 0.5]);
console.log('Waveform peaks: silence and multichannel peaks passed');

const tone = Array.from({length:512},(_,i)=>Math.sin(2*Math.PI*32*i/512));
const bins = context.ToolkitsContent.spectrum(tone);
assert.equal(bins.indexOf(Math.max(...bins)),32);
assert(context.ToolkitsContent.spectrum(new Array(512).fill(0)).every(v=>v===0));
console.log('Spectrum: sine frequency and silence passed');

context.ToolkitsContent.audioBytes('data:audio/wav;base64,UklGRg==').then(buffer => { assert.deepEqual([...new Uint8Array(buffer)], [82,73,70,70]); console.log('Inline audio decoding avoids network fetch'); }).catch(error => { console.error(error); process.exitCode=1; });

const audioBlock = content.content({kind:'audio',label:'输入音频'}, {data:'AAAA'});
const textBlock = content.content({kind:'text',label:'输出文本'}, 'recognized');
const inputSection = context.renderInspectable(new E(), audioBlock);
const outputSection = context.renderInspectable(new E(), textBlock);
inputSection.children.at(-1).click();
assert.equal(ids['detail-content'].children.length, 1);
assert.equal(ids['detail-content'].children[0].dataset.kind, 'audio');
outputSection.children.at(-1).click();
assert.equal(ids['detail-content'].children.length, 1);
assert.equal(ids['detail-content'].children[0].dataset.kind, 'text');
console.log('Individual input/output details are isolated by content type');

const captionEvents=[];
let captionReceiver;
context.crypto=require('crypto').webcrypto;
context.setTimeout=setTimeout;context.clearTimeout=clearTimeout;
context.window={parent:{postMessage(message){
  captionEvents.push(message);
  if(message.action==='open')captionReceiver?.({source:context.window.parent,origin:'https://toolkits-host.test',data:{type:'toolkits-captions-result',requestId:message.requestId}});
}},addEventListener(type,fn){captionReceiver=fn},removeEventListener(){captionReceiver=null}};
context.schema.streaming=true;
const liveReply=new E(),liveContent=new E();
const record=text=>({outputs:[text],messages:[null,{content:[content.content({kind:'text'},text)]}]});
context.renderReply(liveContent,liveReply,record('第一句'));
liveContent.children[0].children.at(-1).click();
assert.equal(captionEvents.at(-1).action,'open');
assert.equal(captionEvents.at(-1).text,'第一句');
context.renderReply(new E(),liveReply,record('第一句，第二句'));
assert.equal(captionEvents.at(-1).action,'update');
assert.equal(captionEvents.at(-1).text,'第一句，第二句');
console.log('Streaming caption button opens overlay and publishes updated transcript snapshots');
