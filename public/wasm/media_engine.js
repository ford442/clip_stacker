
var createMediaEngineModule = (() => {
  var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var a=moduleArg,f,h,k=new Promise((b,c)=>{f=b;h=c}),m="object"==typeof window,n="function"==typeof importScripts,p=Object.assign({},a),q="",r,u;
if(m||n)n?q=self.location.href:"undefined"!=typeof document&&document.currentScript&&(q=document.currentScript.src),_scriptName&&(q=_scriptName),q.startsWith("blob:")?q="":q=q.substr(0,q.replace(/[?#].*/,"").lastIndexOf("/")+1),n&&(u=b=>{var c=new XMLHttpRequest;c.open("GET",b,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),r=b=>fetch(b,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));var v=a.printErr||console.error.bind(console);
Object.assign(a,p);p=null;var w;a.wasmBinary&&(w=a.wasmBinary);var x,y=!1,z;function F(){var b=x.buffer;a.HEAP8=new Int8Array(b);a.HEAP16=new Int16Array(b);a.HEAPU8=z=new Uint8Array(b);a.HEAPU16=new Uint16Array(b);a.HEAP32=new Int32Array(b);a.HEAPU32=new Uint32Array(b);a.HEAPF32=new Float32Array(b);a.HEAPF64=new Float64Array(b)}var G=[],H=[],I=[];function J(){var b=a.preRun.shift();G.unshift(b)}var K=0,L=null,M=null,N=b=>b.startsWith("data:application/octet-stream;base64,"),O;
function P(b){if(b==O&&w)return new Uint8Array(w);if(u)return u(b);throw"both async and sync fetching of the wasm failed";}function Q(b){return w?Promise.resolve().then(()=>P(b)):r(b).then(c=>new Uint8Array(c),()=>P(b))}function R(b,c,e){return Q(b).then(d=>WebAssembly.instantiate(d,c)).then(e,d=>{v(`failed to asynchronously prepare wasm: ${d}`);a.onAbort?.(d);d="Aborted("+d+")";v(d);y=!0;d=new WebAssembly.RuntimeError(d+". Build with -sASSERTIONS for more info.");h(d);throw d;})}
function S(b,c){var e=O;return w||"function"!=typeof WebAssembly.instantiateStreaming||N(e)||"function"!=typeof fetch?R(e,b,c):fetch(e,{credentials:"same-origin"}).then(d=>WebAssembly.instantiateStreaming(d,b).then(c,function(g){v(`wasm streaming compile failed: ${g}`);v("falling back to ArrayBuffer instantiation");return R(e,b,c)}))}
var T=b=>{for(;0<b.length;)b.shift()(a)},U={a:b=>{var c=z.length;b>>>=0;if(536870912<b)return!1;for(var e=1;4>=e;e*=2){var d=c*(1+.2/e);d=Math.min(d,b+100663296);var g=Math;d=Math.max(b,d);a:{g=(g.min.call(g,536870912,d+(65536-d%65536)%65536)-x.buffer.byteLength+65535)/65536;try{x.grow(g);F();var l=1;break a}catch(t){}l=void 0}if(l)return!0}return!1}},V=function(){function b(e){V=e.exports;x=V.b;F();H.unshift(V.c);K--;a.monitorRunDependencies?.(K);0==K&&(null!==L&&(clearInterval(L),L=null),M&&(e=
M,M=null,e()));return V}var c={a:U};K++;a.monitorRunDependencies?.(K);if(a.instantiateWasm)try{return a.instantiateWasm(c,b)}catch(e){v(`Module.instantiateWasm callback failed with error: ${e}`),h(e)}O||=N("media_engine.wasm")?"media_engine.wasm":a.locateFile?a.locateFile("media_engine.wasm",q):q+"media_engine.wasm";S(c,function(e){b(e.instance)}).catch(h);return{}}();a._mix_timeline_audio_range=(b,c,e,d,g,l,t,A,B,C,D,E,Y)=>(a._mix_timeline_audio_range=V.d)(b,c,e,d,g,l,t,A,B,C,D,E,Y);
a._mix_timeline_audio=(b,c,e,d,g,l,t,A,B,C,D,E)=>(a._mix_timeline_audio=V.e)(b,c,e,d,g,l,t,A,B,C,D,E);a._malloc=b=>(a._malloc=V.f)(b);a._free=b=>(a._free=V.g)(b);var W;M=function X(){W||Z();W||(M=X)};
function Z(){function b(){if(!W&&(W=!0,a.calledRun=!0,!y)){T(H);f(a);a.onRuntimeInitialized?.();if(a.postRun)for("function"==typeof a.postRun&&(a.postRun=[a.postRun]);a.postRun.length;){var c=a.postRun.shift();I.unshift(c)}T(I)}}if(!(0<K)){if(a.preRun)for("function"==typeof a.preRun&&(a.preRun=[a.preRun]);a.preRun.length;)J();T(G);0<K||(a.setStatus?(a.setStatus("Running..."),setTimeout(function(){setTimeout(function(){a.setStatus("")},1);b()},1)):b())}}
if(a.preInit)for("function"==typeof a.preInit&&(a.preInit=[a.preInit]);0<a.preInit.length;)a.preInit.pop()();Z();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default createMediaEngineModule;
