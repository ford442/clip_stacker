
var createTimeStretchModule = (() => {
  var _scriptName = import.meta.url;
  
  return (
async function(moduleArg = {}) {
  var moduleRtn;

var b=moduleArg,g,h,k=new Promise((a,c)=>{g=a;h=c}),m="object"==typeof window,n="function"==typeof importScripts,p="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node;if(p){const {createRequire:a}=await import("module");var require=a(import.meta.url)}var q=Object.assign({},b),r="",t,v;
if(p){var fs=require("fs"),w=require("path");r=require("url").fileURLToPath(new URL("./",import.meta.url));v=a=>{a=x(a)?new URL(a):w.normalize(a);return fs.readFileSync(a)};t=a=>{a=x(a)?new URL(a):w.normalize(a);return new Promise((c,d)=>{fs.readFile(a,void 0,(e,f)=>{e?d(e):c(f.buffer)})})};process.argv.slice(2)}else if(m||n)n?r=self.location.href:"undefined"!=typeof document&&document.currentScript&&(r=document.currentScript.src),_scriptName&&(r=_scriptName),r.startsWith("blob:")?r="":
r=r.substr(0,r.replace(/[?#].*/,"").lastIndexOf("/")+1),n&&(v=a=>{var c=new XMLHttpRequest;c.open("GET",a,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),t=a=>fetch(a,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));b.print||console.log.bind(console);var y=b.printErr||console.error.bind(console);Object.assign(b,q);q=null;var z;b.wasmBinary&&(z=b.wasmBinary);var A,B=!1,C;
function D(){var a=A.buffer;b.HEAP8=new Int8Array(a);b.HEAP16=new Int16Array(a);b.HEAPU8=C=new Uint8Array(a);b.HEAPU16=new Uint16Array(a);b.HEAP32=new Int32Array(a);b.HEAPU32=new Uint32Array(a);b.HEAPF32=new Float32Array(a);b.HEAPF64=new Float64Array(a)}var E=[],F=[],G=[];function H(){var a=b.preRun.shift();E.unshift(a)}var I=0,J=null,K=null;function L(a){b.onAbort?.(a);a="Aborted("+a+")";y(a);B=!0;a=new WebAssembly.RuntimeError(a+". Build with -sASSERTIONS for more info.");h(a);throw a;}
var M=a=>a.startsWith("data:application/octet-stream;base64,"),x=a=>a.startsWith("file://"),N;function O(a){if(a==N&&z)return new Uint8Array(z);if(v)return v(a);throw"both async and sync fetching of the wasm failed";}function P(a){return z?Promise.resolve().then(()=>O(a)):t(a).then(c=>new Uint8Array(c),()=>O(a))}function Q(a,c,d){return P(a).then(e=>WebAssembly.instantiate(e,c)).then(d,e=>{y(`failed to asynchronously prepare wasm: ${e}`);L(e)})}
function R(a,c){var d=N;return z||"function"!=typeof WebAssembly.instantiateStreaming||M(d)||p||"function"!=typeof fetch?Q(d,a,c):fetch(d,{credentials:"same-origin"}).then(e=>WebAssembly.instantiateStreaming(e,a).then(c,function(f){y(`wasm streaming compile failed: ${f}`);y("falling back to ArrayBuffer instantiation");return Q(d,a,c)}))}
var S=a=>{for(;0<a.length;)a.shift()(b)},T={b:()=>{L("")},a:a=>{var c=C.length;a>>>=0;if(536870912<a)return!1;for(var d=1;4>=d;d*=2){var e=c*(1+.2/d);e=Math.min(e,a+100663296);var f=Math;e=Math.max(a,e);a:{f=(f.min.call(f,536870912,e+(65536-e%65536)%65536)-A.buffer.byteLength+65535)/65536;try{A.grow(f);D();var l=1;break a}catch(u){}l=void 0}if(l)return!0}return!1}},U=function(){function a(d){U=d.exports;A=U.c;D();F.unshift(U.d);I--;b.monitorRunDependencies?.(I);0==I&&(null!==J&&(clearInterval(J),
J=null),K&&(d=K,K=null,d()));return U}var c={a:T};I++;b.monitorRunDependencies?.(I);if(b.instantiateWasm)try{return b.instantiateWasm(c,a)}catch(d){y(`Module.instantiateWasm callback failed with error: ${d}`),h(d)}N||=b.locateFile?M("time_stretch.wasm")?"time_stretch.wasm":b.locateFile?b.locateFile("time_stretch.wasm",r):r+"time_stretch.wasm":(new URL("time_stretch.wasm",import.meta.url)).href;R(c,function(d){a(d.instance)}).catch(h);return{}}();
b._time_stretch_remap=(a,c,d,e,f,l,u,X)=>(b._time_stretch_remap=U.e)(a,c,d,e,f,l,u,X);b._time_stretch_constant=(a,c,d,e,f,l,u)=>(b._time_stretch_constant=U.f)(a,c,d,e,f,l,u);b._malloc=a=>(b._malloc=U.g)(a);b._free=a=>(b._free=U.h)(a);var V;K=function W(){V||Y();V||(K=W)};
function Y(){function a(){if(!V&&(V=!0,b.calledRun=!0,!B)){S(F);g(b);b.onRuntimeInitialized?.();if(b.postRun)for("function"==typeof b.postRun&&(b.postRun=[b.postRun]);b.postRun.length;){var c=b.postRun.shift();G.unshift(c)}S(G)}}if(!(0<I)){if(b.preRun)for("function"==typeof b.preRun&&(b.preRun=[b.preRun]);b.preRun.length;)H();S(E);0<I||(b.setStatus?(b.setStatus("Running..."),setTimeout(function(){setTimeout(function(){b.setStatus("")},1);a()},1)):a())}}
if(b.preInit)for("function"==typeof b.preInit&&(b.preInit=[b.preInit]);0<b.preInit.length;)b.preInit.pop()();Y();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default createTimeStretchModule;
