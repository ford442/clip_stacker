
var createVideoStabilizeModule = (() => {
  var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var b=moduleArg,f,g,h=new Promise((a,c)=>{f=a;g=c}),l="object"==typeof window,m="function"==typeof importScripts,n=Object.assign({},b),p="",q,r;
if(l||m)m?p=self.location.href:"undefined"!=typeof document&&document.currentScript&&(p=document.currentScript.src),_scriptName&&(p=_scriptName),p.startsWith("blob:")?p="":p=p.substr(0,p.replace(/[?#].*/,"").lastIndexOf("/")+1),m&&(r=a=>{var c=new XMLHttpRequest;c.open("GET",a,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),q=a=>fetch(a,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));var t=b.printErr||console.error.bind(console);
Object.assign(b,n);n=null;var u;b.wasmBinary&&(u=b.wasmBinary);var v,w=!1,x;function y(){var a=v.buffer;b.HEAP8=new Int8Array(a);b.HEAP16=new Int16Array(a);b.HEAPU8=x=new Uint8Array(a);b.HEAPU16=new Uint16Array(a);b.HEAP32=new Int32Array(a);b.HEAPU32=new Uint32Array(a);b.HEAPF32=new Float32Array(a);b.HEAPF64=new Float64Array(a)}var z=[],A=[],B=[];function C(){var a=b.preRun.shift();z.unshift(a)}var D=0,E=null,F=null;
function G(a){b.onAbort?.(a);a="Aborted("+a+")";t(a);w=!0;a=new WebAssembly.RuntimeError(a+". Build with -sASSERTIONS for more info.");g(a);throw a;}var H=a=>a.startsWith("data:application/octet-stream;base64,"),I;function J(a){if(a==I&&u)return new Uint8Array(u);if(r)return r(a);throw"both async and sync fetching of the wasm failed";}function K(a){return u?Promise.resolve().then(()=>J(a)):q(a).then(c=>new Uint8Array(c),()=>J(a))}
function M(a,c,d){return K(a).then(e=>WebAssembly.instantiate(e,c)).then(d,e=>{t(`failed to asynchronously prepare wasm: ${e}`);G(e)})}function N(a,c){var d=I;return u||"function"!=typeof WebAssembly.instantiateStreaming||H(d)||"function"!=typeof fetch?M(d,a,c):fetch(d,{credentials:"same-origin"}).then(e=>WebAssembly.instantiateStreaming(e,a).then(c,function(k){t(`wasm streaming compile failed: ${k}`);t("falling back to ArrayBuffer instantiation");return M(d,a,c)}))}
var O=a=>{for(;0<a.length;)a.shift()(b)},P={c:()=>{G("")},a:(a,c,d)=>x.copyWithin(a,c,c+d),b:a=>{var c=x.length;a>>>=0;if(134217728<a)return!1;for(var d=1;4>=d;d*=2){var e=c*(1+.2/d);e=Math.min(e,a+100663296);var k=Math;e=Math.max(a,e);a:{k=(k.min.call(k,134217728,e+(65536-e%65536)%65536)-v.buffer.byteLength+65535)/65536;try{v.grow(k);y();var L=1;break a}catch(U){}L=void 0}if(L)return!0}return!1}},Q=function(){function a(d){Q=d.exports;v=Q.d;y();A.unshift(Q.e);D--;b.monitorRunDependencies?.(D);0==
D&&(null!==E&&(clearInterval(E),E=null),F&&(d=F,F=null,d()));return Q}var c={a:P};D++;b.monitorRunDependencies?.(D);if(b.instantiateWasm)try{return b.instantiateWasm(c,a)}catch(d){t(`Module.instantiateWasm callback failed with error: ${d}`),g(d)}I||=H("video_stabilize.wasm")?"video_stabilize.wasm":b.locateFile?b.locateFile("video_stabilize.wasm",p):p+"video_stabilize.wasm";N(c,function(d){a(d.instance)}).catch(g);return{}}();b._stab_create=(a,c,d)=>(b._stab_create=Q.f)(a,c,d);
b._stab_push_frame=(a,c)=>(b._stab_push_frame=Q.g)(a,c);b._stab_frame_count=a=>(b._stab_frame_count=Q.h)(a);b._stab_finalize=a=>(b._stab_finalize=Q.i)(a);b._stab_get_matrix=(a,c,d)=>(b._stab_get_matrix=Q.j)(a,c,d);b._stab_get_zoom=a=>(b._stab_get_zoom=Q.k)(a);b._stab_get_max_correction=a=>(b._stab_get_max_correction=Q.l)(a);b._stab_apply_warp=(a,c,d,e)=>(b._stab_apply_warp=Q.m)(a,c,d,e);b._stab_destroy=a=>(b._stab_destroy=Q.n)(a);b._malloc=a=>(b._malloc=Q.o)(a);b._free=a=>(b._free=Q.p)(a);var R;
F=function S(){R||T();R||(F=S)};function T(){function a(){if(!R&&(R=!0,b.calledRun=!0,!w)){O(A);f(b);b.onRuntimeInitialized?.();if(b.postRun)for("function"==typeof b.postRun&&(b.postRun=[b.postRun]);b.postRun.length;){var c=b.postRun.shift();B.unshift(c)}O(B)}}if(!(0<D)){if(b.preRun)for("function"==typeof b.preRun&&(b.preRun=[b.preRun]);b.preRun.length;)C();O(z);0<D||(b.setStatus?(b.setStatus("Running..."),setTimeout(function(){setTimeout(function(){b.setStatus("")},1);a()},1)):a())}}
if(b.preInit)for("function"==typeof b.preInit&&(b.preInit=[b.preInit]);0<b.preInit.length;)b.preInit.pop()();T();moduleRtn=h;


  return moduleRtn;
}
);
})();
export default createVideoStabilizeModule;
