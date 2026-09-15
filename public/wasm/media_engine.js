
var createMediaEngineModule = (() => {
  var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var a=moduleArg,f,h,k=new Promise((b,c)=>{f=b;h=c}),l="object"==typeof window,m="function"==typeof importScripts,n=Object.assign({},a),p="",q,t;
if(l||m)m?p=self.location.href:"undefined"!=typeof document&&document.currentScript&&(p=document.currentScript.src),_scriptName&&(p=_scriptName),p.startsWith("blob:")?p="":p=p.substr(0,p.replace(/[?#].*/,"").lastIndexOf("/")+1),m&&(t=b=>{var c=new XMLHttpRequest;c.open("GET",b,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),q=b=>fetch(b,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));var u=a.printErr||console.error.bind(console);
Object.assign(a,n);n=null;var v;a.wasmBinary&&(v=a.wasmBinary);var w,x=!1,y;function z(){var b=w.buffer;a.HEAP8=new Int8Array(b);a.HEAP16=new Int16Array(b);a.HEAPU8=y=new Uint8Array(b);a.HEAPU16=new Uint16Array(b);a.HEAP32=new Int32Array(b);a.HEAPU32=new Uint32Array(b);a.HEAPF32=new Float32Array(b);a.HEAPF64=new Float64Array(b)}var A=[],B=[],C=[];function D(){var b=a.preRun.shift();A.unshift(b)}var E=0,F=null,G=null,H=b=>b.startsWith("data:application/octet-stream;base64,"),I;
function J(b){if(b==I&&v)return new Uint8Array(v);if(t)return t(b);throw"both async and sync fetching of the wasm failed";}function K(b){return v?Promise.resolve().then(()=>J(b)):q(b).then(c=>new Uint8Array(c),()=>J(b))}function M(b,c,e){return K(b).then(d=>WebAssembly.instantiate(d,c)).then(e,d=>{u(`failed to asynchronously prepare wasm: ${d}`);a.onAbort?.(d);d="Aborted("+d+")";u(d);x=!0;d=new WebAssembly.RuntimeError(d+". Build with -sASSERTIONS for more info.");h(d);throw d;})}
function N(b,c){var e=I;return v||"function"!=typeof WebAssembly.instantiateStreaming||H(e)||"function"!=typeof fetch?M(e,b,c):fetch(e,{credentials:"same-origin"}).then(d=>WebAssembly.instantiateStreaming(d,b).then(c,function(g){u(`wasm streaming compile failed: ${g}`);u("falling back to ArrayBuffer instantiation");return M(e,b,c)}))}
var O=b=>{for(;0<b.length;)b.shift()(a)},P={a:b=>{var c=y.length;b>>>=0;if(536870912<b)return!1;for(var e=1;4>=e;e*=2){var d=c*(1+.2/e);d=Math.min(d,b+100663296);var g=Math;d=Math.max(b,d);a:{g=(g.min.call(g,536870912,d+(65536-d%65536)%65536)-w.buffer.byteLength+65535)/65536;try{w.grow(g);z();var r=1;break a}catch(L){}r=void 0}if(r)return!0}return!1}},Q=function(){function b(e){Q=e.exports;w=Q.b;z();B.unshift(Q.c);E--;a.monitorRunDependencies?.(E);0==E&&(null!==F&&(clearInterval(F),F=null),G&&(e=
G,G=null,e()));return Q}var c={a:P};E++;a.monitorRunDependencies?.(E);if(a.instantiateWasm)try{return a.instantiateWasm(c,b)}catch(e){u(`Module.instantiateWasm callback failed with error: ${e}`),h(e)}I||=H("media_engine.wasm")?"media_engine.wasm":a.locateFile?a.locateFile("media_engine.wasm",p):p+"media_engine.wasm";N(c,function(e){b(e.instance)}).catch(h);return{}}();a._mix_timeline_audio=(b,c,e,d,g,r,L,T,U)=>(a._mix_timeline_audio=Q.d)(b,c,e,d,g,r,L,T,U);a._malloc=b=>(a._malloc=Q.e)(b);
a._free=b=>(a._free=Q.f)(b);var R;G=function S(){R||V();R||(G=S)};
function V(){function b(){if(!R&&(R=!0,a.calledRun=!0,!x)){O(B);f(a);a.onRuntimeInitialized?.();if(a.postRun)for("function"==typeof a.postRun&&(a.postRun=[a.postRun]);a.postRun.length;){var c=a.postRun.shift();C.unshift(c)}O(C)}}if(!(0<E)){if(a.preRun)for("function"==typeof a.preRun&&(a.preRun=[a.preRun]);a.preRun.length;)D();O(A);0<E||(a.setStatus?(a.setStatus("Running..."),setTimeout(function(){setTimeout(function(){a.setStatus("")},1);b()},1)):b())}}
if(a.preInit)for("function"==typeof a.preInit&&(a.preInit=[a.preInit]);0<a.preInit.length;)a.preInit.pop()();V();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default createMediaEngineModule;
