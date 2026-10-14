
var createMediaEngineModule = (() => {
  var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var b=moduleArg,f,h,m=new Promise((a,c)=>{f=a;h=c}),n="object"==typeof window,p="function"==typeof importScripts,q=Object.assign({},b),x="",y,z;
if(n||p)p?x=self.location.href:"undefined"!=typeof document&&document.currentScript&&(x=document.currentScript.src),_scriptName&&(x=_scriptName),x.startsWith("blob:")?x="":x=x.substr(0,x.replace(/[?#].*/,"").lastIndexOf("/")+1),p&&(z=a=>{var c=new XMLHttpRequest;c.open("GET",a,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),y=a=>fetch(a,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));var A=b.printErr||console.error.bind(console);
Object.assign(b,q);q=null;var B;b.wasmBinary&&(B=b.wasmBinary);var C,D=!1,E;function F(){var a=C.buffer;b.HEAP8=new Int8Array(a);b.HEAP16=new Int16Array(a);b.HEAPU8=E=new Uint8Array(a);b.HEAPU16=new Uint16Array(a);b.HEAP32=new Int32Array(a);b.HEAPU32=new Uint32Array(a);b.HEAPF32=new Float32Array(a);b.HEAPF64=new Float64Array(a)}var G=[],H=[],I=[];function J(){var a=b.preRun.shift();G.unshift(a)}var K=0,L=null,M=null;
function N(a){b.onAbort?.(a);a="Aborted("+a+")";A(a);D=!0;a=new WebAssembly.RuntimeError(a+". Build with -sASSERTIONS for more info.");h(a);throw a;}var O=a=>a.startsWith("data:application/octet-stream;base64,"),P;function Q(a){if(a==P&&B)return new Uint8Array(B);if(z)return z(a);throw"both async and sync fetching of the wasm failed";}function R(a){return B?Promise.resolve().then(()=>Q(a)):y(a).then(c=>new Uint8Array(c),()=>Q(a))}
function S(a,c,d){return R(a).then(e=>WebAssembly.instantiate(e,c)).then(d,e=>{A(`failed to asynchronously prepare wasm: ${e}`);N(e)})}function T(a,c){var d=P;return B||"function"!=typeof WebAssembly.instantiateStreaming||O(d)||"function"!=typeof fetch?S(d,a,c):fetch(d,{credentials:"same-origin"}).then(e=>WebAssembly.instantiateStreaming(e,a).then(c,function(g){A(`wasm streaming compile failed: ${g}`);A("falling back to ArrayBuffer instantiation");return S(d,a,c)}))}
var U=a=>{for(;0<a.length;)a.shift()(b)},V={c:()=>{N("")},a:(a,c,d)=>E.copyWithin(a,c,c+d),b:a=>{var c=E.length;a>>>=0;if(536870912<a)return!1;for(var d=1;4>=d;d*=2){var e=c*(1+.2/d);e=Math.min(e,a+100663296);var g=Math;e=Math.max(a,e);a:{g=(g.min.call(g,536870912,e+(65536-e%65536)%65536)-C.buffer.byteLength+65535)/65536;try{C.grow(g);F();var k=1;break a}catch(l){}k=void 0}if(k)return!0}return!1}},W=function(){function a(d){W=d.exports;C=W.d;F();H.unshift(W.e);K--;b.monitorRunDependencies?.(K);0==
K&&(null!==L&&(clearInterval(L),L=null),M&&(d=M,M=null,d()));return W}var c={a:V};K++;b.monitorRunDependencies?.(K);if(b.instantiateWasm)try{return b.instantiateWasm(c,a)}catch(d){A(`Module.instantiateWasm callback failed with error: ${d}`),h(d)}P||=O("media_engine.wasm")?"media_engine.wasm":b.locateFile?b.locateFile("media_engine.wasm",x):x+"media_engine.wasm";T(c,function(d){a(d.instance)}).catch(h);return{}}();
b._mix_timeline_audio_range=(a,c,d,e,g,k,l,r,t,u,v,w,Z)=>(b._mix_timeline_audio_range=W.f)(a,c,d,e,g,k,l,r,t,u,v,w,Z);b._mix_timeline_audio=(a,c,d,e,g,k,l,r,t,u,v,w)=>(b._mix_timeline_audio=W.g)(a,c,d,e,g,k,l,r,t,u,v,w);b._mix_fx_session_create=(a,c,d,e,g,k,l)=>(b._mix_fx_session_create=W.h)(a,c,d,e,g,k,l);b._mix_fx_session_destroy=a=>(b._mix_fx_session_destroy=W.i)(a);b._mix_fx_session_latency=a=>(b._mix_fx_session_latency=W.j)(a);
b._mix_fx_session_range=(a,c,d,e,g,k,l,r,t,u,v,w)=>(b._mix_fx_session_range=W.k)(a,c,d,e,g,k,l,r,t,u,v,w);b._insert_chain_create=(a,c,d)=>(b._insert_chain_create=W.l)(a,c,d);b._insert_chain_process=(a,c,d,e)=>(b._insert_chain_process=W.m)(a,c,d,e);b._insert_chain_destroy=a=>(b._insert_chain_destroy=W.n)(a);b._malloc=a=>(b._malloc=W.o)(a);b._free=a=>(b._free=W.p)(a);var X;M=function aa(){X||Y();X||(M=aa)};
function Y(){function a(){if(!X&&(X=!0,b.calledRun=!0,!D)){U(H);f(b);b.onRuntimeInitialized?.();if(b.postRun)for("function"==typeof b.postRun&&(b.postRun=[b.postRun]);b.postRun.length;){var c=b.postRun.shift();I.unshift(c)}U(I)}}if(!(0<K)){if(b.preRun)for("function"==typeof b.preRun&&(b.preRun=[b.preRun]);b.preRun.length;)J();U(G);0<K||(b.setStatus?(b.setStatus("Running..."),setTimeout(function(){setTimeout(function(){b.setStatus("")},1);a()},1)):a())}}
if(b.preInit)for("function"==typeof b.preInit&&(b.preInit=[b.preInit]);0<b.preInit.length;)b.preInit.pop()();Y();moduleRtn=m;


  return moduleRtn;
}
);
})();
export default createMediaEngineModule;
