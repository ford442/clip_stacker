
var createMediaEngineModule = (() => {
  var _scriptName = import.meta.url;
  
  return (
async function(moduleArg = {}) {
  var moduleRtn;

var b=moduleArg,f,h,k=new Promise((a,c)=>{f=a;h=c}),l="object"==typeof window,m="function"==typeof importScripts,n="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node;if(n){const {createRequire:a}=await import("module");var require=a(import.meta.url)}var p=Object.assign({},b),q="",r,u;
if(n){var fs=require("fs"),v=require("path");q=require("url").fileURLToPath(new URL("./",import.meta.url));u=a=>{a=w(a)?new URL(a):v.normalize(a);return fs.readFileSync(a)};r=a=>{a=w(a)?new URL(a):v.normalize(a);return new Promise((c,e)=>{fs.readFile(a,void 0,(d,g)=>{d?e(d):c(g.buffer)})})};process.argv.slice(2)}else if(l||m)m?q=self.location.href:"undefined"!=typeof document&&document.currentScript&&(q=document.currentScript.src),_scriptName&&(q=_scriptName),q.startsWith("blob:")?q="":
q=q.substr(0,q.replace(/[?#].*/,"").lastIndexOf("/")+1),m&&(u=a=>{var c=new XMLHttpRequest;c.open("GET",a,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),r=a=>fetch(a,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));b.print||console.log.bind(console);var x=b.printErr||console.error.bind(console);Object.assign(b,p);p=null;var y;b.wasmBinary&&(y=b.wasmBinary);var z,A=!1,B;
function C(){var a=z.buffer;b.HEAP8=new Int8Array(a);b.HEAP16=new Int16Array(a);b.HEAPU8=B=new Uint8Array(a);b.HEAPU16=new Uint16Array(a);b.HEAP32=new Int32Array(a);b.HEAPU32=new Uint32Array(a);b.HEAPF32=new Float32Array(a);b.HEAPF64=new Float64Array(a)}var D=[],E=[],F=[];function G(){var a=b.preRun.shift();D.unshift(a)}var H=0,I=null,J=null,K=a=>a.startsWith("data:application/octet-stream;base64,"),w=a=>a.startsWith("file://"),L;
function M(a){if(a==L&&y)return new Uint8Array(y);if(u)return u(a);throw"both async and sync fetching of the wasm failed";}function N(a){return y?Promise.resolve().then(()=>M(a)):r(a).then(c=>new Uint8Array(c),()=>M(a))}function P(a,c,e){return N(a).then(d=>WebAssembly.instantiate(d,c)).then(e,d=>{x(`failed to asynchronously prepare wasm: ${d}`);b.onAbort?.(d);d="Aborted("+d+")";x(d);A=!0;d=new WebAssembly.RuntimeError(d+". Build with -sASSERTIONS for more info.");h(d);throw d;})}
function Q(a,c){var e=L;return y||"function"!=typeof WebAssembly.instantiateStreaming||K(e)||n||"function"!=typeof fetch?P(e,a,c):fetch(e,{credentials:"same-origin"}).then(d=>WebAssembly.instantiateStreaming(d,a).then(c,function(g){x(`wasm streaming compile failed: ${g}`);x("falling back to ArrayBuffer instantiation");return P(e,a,c)}))}
var R=a=>{for(;0<a.length;)a.shift()(b)},S={a:a=>{var c=B.length;a>>>=0;if(536870912<a)return!1;for(var e=1;4>=e;e*=2){var d=c*(1+.2/e);d=Math.min(d,a+100663296);var g=Math;d=Math.max(a,d);a:{g=(g.min.call(g,536870912,d+(65536-d%65536)%65536)-z.buffer.byteLength+65535)/65536;try{z.grow(g);C();var t=1;break a}catch(O){}t=void 0}if(t)return!0}return!1}},T=function(){function a(e){T=e.exports;z=T.b;C();E.unshift(T.c);H--;b.monitorRunDependencies?.(H);0==H&&(null!==I&&(clearInterval(I),I=null),J&&(e=
J,J=null,e()));return T}var c={a:S};H++;b.monitorRunDependencies?.(H);if(b.instantiateWasm)try{return b.instantiateWasm(c,a)}catch(e){x(`Module.instantiateWasm callback failed with error: ${e}`),h(e)}L||=b.locateFile?K("media_engine.wasm")?"media_engine.wasm":b.locateFile?b.locateFile("media_engine.wasm",q):q+"media_engine.wasm":(new URL("media_engine.wasm",import.meta.url)).href;Q(c,function(e){a(e.instance)}).catch(h);return{}}();
b._mix_timeline_audio=(a,c,e,d,g,t,O,W,X)=>(b._mix_timeline_audio=T.d)(a,c,e,d,g,t,O,W,X);b._malloc=a=>(b._malloc=T.e)(a);b._free=a=>(b._free=T.f)(a);var U;J=function V(){U||Y();U||(J=V)};
function Y(){function a(){if(!U&&(U=!0,b.calledRun=!0,!A)){R(E);f(b);b.onRuntimeInitialized?.();if(b.postRun)for("function"==typeof b.postRun&&(b.postRun=[b.postRun]);b.postRun.length;){var c=b.postRun.shift();F.unshift(c)}R(F)}}if(!(0<H)){if(b.preRun)for("function"==typeof b.preRun&&(b.preRun=[b.preRun]);b.preRun.length;)G();R(D);0<H||(b.setStatus?(b.setStatus("Running..."),setTimeout(function(){setTimeout(function(){b.setStatus("")},1);a()},1)):a())}}
if(b.preInit)for("function"==typeof b.preInit&&(b.preInit=[b.preInit]);0<b.preInit.length;)b.preInit.pop()();Y();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default createMediaEngineModule;
