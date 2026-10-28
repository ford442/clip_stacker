// AudioWorklet processor for the preview's lane buses (see src/wasm/audioFx.ts).
//
// A thin shim over `media_engine_fx.wasm`, the glue-free build of the media
// engine's bus graph (native/media_engine/src/fx/bus.cpp) — the same C++ the
// export premix runs, so preview and export process identical samples. The
// main thread compiles the module and hands it over in `processorOptions`
// (an AudioWorkletGlobalScope has no fetch or importScripts).
//
// Inputs: one per lane bus in packed order, then the direct (unrouted) input.
// Output: the master bus, delayed by the graph's look-ahead (limiters).
//
// Messages in:  { type: 'layout', layout }   retune in place, or rebuild
//               { type: 'reset' }            clear filters and delay lines (seek)
//               { type: 'resetMeter' }       restart integrated / range / peaks
// Messages out: { type: 'ready', latency } / { type: 'error', message }
//               { type: 'meters', values }   about 10 times a second
//
// Until the module is ready, and if it ever fails, the processor passes the
// summed lanes through dry and says so; the main thread shows the
// "FX not previewed" badge.

const QUANTUM = 128;
const METER_INTERVAL_FRAMES = 4800;
/** `MIX_METER_LANE_GR` in audio_mix.h: where the per-lane readouts start. */
const METER_LANE_BASE = 7;
const CS_ESTATE = -3;

class BusFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.lanes = Math.max(0, (options && options.numberOfInputs ? options.numberOfInputs : 1) - 1);
    this.layout = opts.layout || null;
    this.exports = null;
    this.graph = 0;
    this.failed = false;
    this.sinceMeter = 0;
    this.lanePtr = 0;
    this.outPtr = 0;
    this.meterPtr = 0;
    this.layoutPtr = 0;
    this.layoutBytes = 0;
    this.heapBuffer = null;
    this.f32 = null;
    this.port.onmessage = (event) => this.onMessage(event.data);
    const imports = { env: { emscripten_notify_memory_growth() {} } };
    WebAssembly.instantiate(opts.module, imports).then(
      (instance) => this.onInstance(instance),
      (err) => this.fail(`instantiate: ${err && err.message ? err.message : err}`),
    );
  }

  onInstance(instance) {
    const ex = instance.exports;
    this.exports = ex;
    if (typeof ex._initialize === 'function') ex._initialize();
    this.lanePtr = ex.malloc((this.lanes + 1) * QUANTUM * 2 * 4);
    this.outPtr = ex.malloc(QUANTUM * 2 * 4);
    this.meterPtr = ex.malloc((METER_LANE_BASE + this.lanes) * 8);
    if (!this.lanePtr || !this.outPtr || !this.meterPtr) {
      this.fail('out of memory');
      return;
    }
    if (this.layout) this.applyLayout(this.layout);
  }

  fail(message) {
    this.failed = true;
    this.port.postMessage({ type: 'error', message });
  }

  views() {
    const buffer = this.exports.memory.buffer;
    if (buffer !== this.heapBuffer) {
      this.heapBuffer = buffer;
      this.f32 = new Float32Array(buffer);
    }
    return this.f32;
  }

  /** Copy the layout's arrays into the heap; returns pointers or null. */
  stage(layout) {
    const ex = this.exports;
    const effects = layout.effects.length > 0 ? layout.effects : new Float64Array(1);
    const bytes = effects.length * 8 + Math.max(1, layout.buses.length) * 4 + 8;
    if (bytes > this.layoutBytes) {
      if (this.layoutPtr) ex.free(this.layoutPtr);
      this.layoutPtr = ex.malloc(bytes);
      this.layoutBytes = this.layoutPtr ? bytes : 0;
      if (!this.layoutPtr) return null;
    }
    const effectsPtr = (this.layoutPtr + 7) & ~7;
    const busesPtr = effectsPtr + effects.length * 8;
    new Float64Array(ex.memory.buffer, effectsPtr, effects.length).set(effects);
    new Int32Array(ex.memory.buffer, busesPtr, layout.buses.length).set(layout.buses);
    return { effectsPtr, effectCount: layout.effectCount, busesPtr };
  }

  applyLayout(layout) {
    this.layout = layout;
    if (!this.exports || this.failed) return;
    const ex = this.exports;
    const staged = this.stage(layout);
    if (!staged) {
      this.fail('out of memory');
      return;
    }
    const laneCount = layout.buses.length / 2;
    const args = [
      staged.effectsPtr,
      staged.effectCount,
      staged.busesPtr,
      laneCount,
      layout.masterFirst,
      layout.masterCount,
      layout.outputGainDb,
      layout.finalFirst,
      layout.finalCount,
    ];
    if (this.graph && ex.bus_graph_update(this.graph, ...args) !== CS_ESTATE) return;
    const next = ex.bus_graph_create(sampleRate, 2, ...args, layout.flags);
    if (!next) {
      this.fail('bus graph rejected the layout');
      return;
    }
    if (this.graph) ex.bus_graph_destroy(this.graph);
    this.graph = next;
    this.port.postMessage({ type: 'ready', latency: ex.bus_graph_latency(next) });
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'layout') {
      this.applyLayout(message.layout);
    } else if (message.type === 'reset' && this.graph) {
      this.exports.bus_graph_reset(this.graph);
    } else if (message.type === 'resetMeter' && this.graph) {
      this.exports.bus_graph_reset_meter(this.graph);
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    if (!this.graph || this.failed || frames > QUANTUM) {
      passThrough(inputs, output, frames);
      return true;
    }
    const heap = this.views();
    const lanes = this.lanes;
    for (let l = 0; l <= lanes; l++) {
      const input = inputs[l];
      const base = (this.lanePtr >> 2) + l * frames * 2;
      if (!input || input.length === 0) {
        heap.fill(0, base, base + frames * 2);
        continue;
      }
      const left = input[0];
      const right = input.length > 1 ? input[1] : input[0];
      for (let i = 0; i < frames; i++) {
        heap[base + 2 * i] = left[i];
        heap[base + 2 * i + 1] = right[i];
      }
    }
    this.exports.bus_graph_process(this.graph, this.lanePtr, this.outPtr, frames);
    const out = this.views();
    const o = this.outPtr >> 2;
    const left = output[0];
    const right = output.length > 1 ? output[1] : null;
    for (let i = 0; i < frames; i++) {
      left[i] = out[o + 2 * i];
      if (right) right[i] = out[o + 2 * i + 1];
    }
    this.sinceMeter += frames;
    if (this.sinceMeter >= METER_INTERVAL_FRAMES && this.layout && this.layout.flags & 1) {
      this.sinceMeter = 0;
      const capacity = METER_LANE_BASE + lanes;
      const n = this.exports.bus_graph_meters(this.graph, this.meterPtr, capacity);
      if (n > 0) {
        const values = new Float64Array(this.exports.memory.buffer, this.meterPtr, n).slice();
        this.port.postMessage({ type: 'meters', values }, [values.buffer]);
      }
    }
    return true;
  }
}

/** Sum every input into the output, dry. */
function passThrough(inputs, output, frames) {
  for (let c = 0; c < output.length; c++) output[c].fill(0);
  for (const input of inputs) {
    if (!input || input.length === 0) continue;
    for (let c = 0; c < output.length; c++) {
      const src = input[Math.min(c, input.length - 1)];
      const dst = output[c];
      for (let i = 0; i < frames; i++) dst[i] += src[i];
    }
  }
}

registerProcessor('clip-stacker-bus-fx', BusFxProcessor);
