
var createTimeStretchModule = (() => {
  var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;
  
  return (
function(moduleArg = {}) {
  var moduleRtn;

var b=moduleArg,f,h,k=new Promise((a,c)=>{f=a;h=c}),m="object"==typeof window,n="function"==typeof importScripts,p=Object.assign({},b),q="",r,u;
if(m||n)n?q=self.location.href:"undefined"!=typeof document&&document.currentScript&&(q=document.currentScript.src),_scriptName&&(q=_scriptName),q.startsWith("blob:")?q="":q=q.substr(0,q.replace(/[?#].*/,"").lastIndexOf("/")+1),n&&(u=a=>{var c=new XMLHttpRequest;c.open("GET",a,!1);c.responseType="arraybuffer";c.send(null);return new Uint8Array(c.response)}),r=a=>fetch(a,{credentials:"same-origin"}).then(c=>c.ok?c.arrayBuffer():Promise.reject(Error(c.status+" : "+c.url)));var v=b.printErr||console.error.bind(console);
Object.assign(b,p);p=null;var w;b.wasmBinary&&(w=b.wasmBinary);var x,y=!1,z;function A(){var a=x.buffer;b.HEAP8=new Int8Array(a);b.HEAP16=new Int16Array(a);b.HEAPU8=z=new Uint8Array(a);b.HEAPU16=new Uint16Array(a);b.HEAP32=new Int32Array(a);b.HEAPU32=new Uint32Array(a);b.HEAPF32=new Float32Array(a);b.HEAPF64=new Float64Array(a)}var B=[],C=[],D=[];function E(){var a=b.preRun.shift();B.unshift(a)}var F=0,G=null,H=null;
function I(a){b.onAbort?.(a);a="Aborted("+a+")";v(a);y=!0;a=new WebAssembly.RuntimeError(a+". Build with -sASSERTIONS for more info.");h(a);throw a;}var J=a=>a.startsWith("data:application/octet-stream;base64,"),K;function L(a){if(a==K&&w)return new Uint8Array(w);if(u)return u(a);throw"both async and sync fetching of the wasm failed";}function M(a){return w?Promise.resolve().then(()=>L(a)):r(a).then(c=>new Uint8Array(c),()=>L(a))}
function N(a,c,d){return M(a).then(e=>WebAssembly.instantiate(e,c)).then(d,e=>{v(`failed to asynchronously prepare wasm: ${e}`);I(e)})}function O(a,c){var d=K;return w||"function"!=typeof WebAssembly.instantiateStreaming||J(d)||"function"!=typeof fetch?N(d,a,c):fetch(d,{credentials:"same-origin"}).then(e=>WebAssembly.instantiateStreaming(e,a).then(c,function(g){v(`wasm streaming compile failed: ${g}`);v("falling back to ArrayBuffer instantiation");return N(d,a,c)}))}
var P=a=>{for(;0<a.length;)a.shift()(b)},Q={b:()=>{I("")},a:a=>{var c=z.length;a>>>=0;if(536870912<a)return!1;for(var d=1;4>=d;d*=2){var e=c*(1+.2/d);e=Math.min(e,a+100663296);var g=Math;e=Math.max(a,e);a:{g=(g.min.call(g,536870912,e+(65536-e%65536)%65536)-x.buffer.byteLength+65535)/65536;try{x.grow(g);A();var l=1;break a}catch(t){}l=void 0}if(l)return!0}return!1}},R=function(){function a(d){R=d.exports;x=R.c;A();C.unshift(R.d);F--;b.monitorRunDependencies?.(F);0==F&&(null!==G&&(clearInterval(G),
G=null),H&&(d=H,H=null,d()));return R}var c={a:Q};F++;b.monitorRunDependencies?.(F);if(b.instantiateWasm)try{return b.instantiateWasm(c,a)}catch(d){v(`Module.instantiateWasm callback failed with error: ${d}`),h(d)}K||=J("time_stretch.wasm")?"time_stretch.wasm":b.locateFile?b.locateFile("time_stretch.wasm",q):q+"time_stretch.wasm";O(c,function(d){a(d.instance)}).catch(h);return{}}();b._time_stretch_remap=(a,c,d,e,g,l,t,U)=>(b._time_stretch_remap=R.e)(a,c,d,e,g,l,t,U);
b._time_stretch_constant=(a,c,d,e,g,l,t)=>(b._time_stretch_constant=R.f)(a,c,d,e,g,l,t);b._malloc=a=>(b._malloc=R.g)(a);b._free=a=>(b._free=R.h)(a);var S;H=function T(){S||V();S||(H=T)};
function V(){function a(){if(!S&&(S=!0,b.calledRun=!0,!y)){P(C);f(b);b.onRuntimeInitialized?.();if(b.postRun)for("function"==typeof b.postRun&&(b.postRun=[b.postRun]);b.postRun.length;){var c=b.postRun.shift();D.unshift(c)}P(D)}}if(!(0<F)){if(b.preRun)for("function"==typeof b.preRun&&(b.preRun=[b.preRun]);b.preRun.length;)E();P(B);0<F||(b.setStatus?(b.setStatus("Running..."),setTimeout(function(){setTimeout(function(){b.setStatus("")},1);a()},1)):a())}}
if(b.preInit)for("function"==typeof b.preInit&&(b.preInit=[b.preInit]);0<b.preInit.length;)b.preInit.pop()();V();moduleRtn=k;


  return moduleRtn;
}
);
})();
export default createTimeStretchModule;
