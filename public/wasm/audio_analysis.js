
var createAudioAnalysisModule = (() => {
  var _scriptName = import.meta.url;
  
  return (
async function(moduleArg = {}) {
  var moduleRtn;

var b=moduleArg,f,g,k=new Promise((a,c)=>{f=a;g=c}),l="object"==typeof window,m="function"==typeof importScripts,n="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node;if(n){const {createRequire:a}=await import("module");var require=a(import.meta.url)}var p=Object.assign({},b),q="",r,t;
if(n){var fs=require("fs"),u=require("path");q=require("url").fileURLToPath(new URL("./",import.meta.url));t=a=>{a=v(a)?new URL(a):u.normalize(a);return fs.readFileSync(a)};r=a=>{a=v(a)?new URL(a):u.normalize(a);return new Promise((c,d)=>{fs.readFile(a,void 0,(e,h)=>{e?d(e):c(h.buffer)})})};process.argv.slice(2)}else if(l||m)m?q=self.location.href:"undefined"!=typeof document&&document.currentScript&&(q=document.currentScript.src),_scriptName&&(q=_scriptName),q.startsWith("blob:")?q="":
q=q.substr(0,q.replace(/[?#].*/,"").lastIndexOf("/")+1),m&&(t=a=>{var c=new XMLHttpRequest;c.open("GET",a,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),r=a=>fetch(a,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));b.print||console.log.bind(console);var w=b.printErr||console.error.bind(console);Object.assign(b,p);p=null;var x;b.wasmBinary&&(x=b.wasmBinary);var y,z=!1,A;
function B(){var a=y.buffer;b.HEAP8=new Int8Array(a);b.HEAP16=new Int16Array(a);b.HEAPU8=A=new Uint8Array(a);b.HEAPU16=new Uint16Array(a);b.HEAP32=new Int32Array(a);b.HEAPU32=new Uint32Array(a);b.HEAPF32=new Float32Array(a);b.HEAPF64=new Float64Array(a)}var C=[],D=[],E=[];function F(){var a=b.preRun.shift();C.unshift(a)}var G=0,H=null,I=null;function J(a){b.onAbort?.(a);a="Aborted("+a+")";w(a);z=!0;a=new WebAssembly.RuntimeError(a+". Build with -sASSERTIONS for more info.");g(a);throw a;}
var K=a=>a.startsWith("data:application/octet-stream;base64,"),v=a=>a.startsWith("file://"),L;function M(a){if(a==L&&x)return new Uint8Array(x);if(t)return t(a);throw"both async and sync fetching of the wasm failed";}function N(a){return x?Promise.resolve().then(()=>M(a)):r(a).then(c=>new Uint8Array(c),()=>M(a))}function P(a,c,d){return N(a).then(e=>WebAssembly.instantiate(e,c)).then(d,e=>{w(`failed to asynchronously prepare wasm: ${e}`);J(e)})}
function Q(a,c){var d=L;return x||"function"!=typeof WebAssembly.instantiateStreaming||K(d)||n||"function"!=typeof fetch?P(d,a,c):fetch(d,{credentials:"same-origin"}).then(e=>WebAssembly.instantiateStreaming(e,a).then(c,function(h){w(`wasm streaming compile failed: ${h}`);w("falling back to ArrayBuffer instantiation");return P(d,a,c)}))}
var R=a=>{for(;0<a.length;)a.shift()(b)},S={c:()=>{J("")},a:(a,c,d)=>A.copyWithin(a,c,c+d),b:a=>{var c=A.length;a>>>=0;if(67108864<a)return!1;for(var d=1;4>=d;d*=2){var e=c*(1+.2/d);e=Math.min(e,a+100663296);var h=Math;e=Math.max(a,e);a:{h=(h.min.call(h,67108864,e+(65536-e%65536)%65536)-y.buffer.byteLength+65535)/65536;try{y.grow(h);B();var O=1;break a}catch(X){}O=void 0}if(O)return!0}return!1}},T=function(){function a(d){T=d.exports;y=T.d;B();D.unshift(T.e);G--;b.monitorRunDependencies?.(G);0==G&&
(null!==H&&(clearInterval(H),H=null),I&&(d=I,I=null,d()));return T}var c={a:S};G++;b.monitorRunDependencies?.(G);if(b.instantiateWasm)try{return b.instantiateWasm(c,a)}catch(d){w(`Module.instantiateWasm callback failed with error: ${d}`),g(d)}L||=b.locateFile?K("audio_analysis.wasm")?"audio_analysis.wasm":b.locateFile?b.locateFile("audio_analysis.wasm",q):q+"audio_analysis.wasm":(new URL("audio_analysis.wasm",import.meta.url)).href;Q(c,function(d){a(d.instance)}).catch(g);return{}}();
b._createAnalyzer=(a,c)=>(b._createAnalyzer=T.f)(a,c);b._resetAnalyzer=a=>(b._resetAnalyzer=T.g)(a);b._destroyAnalyzer=a=>(b._destroyAnalyzer=T.h)(a);b._free=a=>(b._free=T.i)(a);b._getHopSize=a=>(b._getHopSize=T.j)(a);b._analyzeFrame=(a,c,d,e,h)=>(b._analyzeFrame=T.k)(a,c,d,e,h);b._malloc=a=>(b._malloc=T.l)(a);var U;I=function V(){U||W();U||(I=V)};
function W(){function a(){if(!U&&(U=!0,b.calledRun=!0,!z)){R(D);f(b);b.onRuntimeInitialized?.();if(b.postRun)for("function"==typeof b.postRun&&(b.postRun=[b.postRun]);b.postRun.length;){var c=b.postRun.shift();E.unshift(c)}R(E)}}if(!(0<G)){if(b.preRun)for("function"==typeof b.preRun&&(b.preRun=[b.preRun]);b.preRun.length;)F();R(C);0<G||(b.setStatus?(b.setStatus("Running..."),setTimeout(function(){setTimeout(function(){b.setStatus("")},1);a()},1)):a())}}
if(b.preInit)for("function"==typeof b.preInit&&(b.preInit=[b.preInit]);0<b.preInit.length;)b.preInit.pop()();W();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default createAudioAnalysisModule;
