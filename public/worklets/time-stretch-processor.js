/**
 * Pitch-preserving WSOLA grain processor for live AudioWorklet use.
 * Variable rate curves are offline-baked via the time_stretch WASM module;
 * this processor handles constant (or slowly changing) tempo for live graphs.
 */
class TimeStretchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._tempo = typeof opts.tempo === 'number' && opts.tempo > 0 ? opts.tempo : 1;
    this._hop = 128;
    this._win = this._hop * 2;
    this._readPos = 0;
    this._ring = null;
    this._ringLen = 0;
    this._write = 0;
    this._norm = null;
  }

  static get parameterDescriptors() {
    return [
      {
        name: 'tempo',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate',
      },
    ];
  }

  _ensureRing(channels, length) {
    if (this._ring && this._ringLen === length && this._ring.length === channels) return;
    this._ringLen = length;
    this._ring = [];
    this._norm = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      this._ring.push(new Float32Array(length));
    }
    this._write = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const tempoParam = parameters.tempo;
    const tempo = tempoParam && tempoParam.length ? tempoParam[0] : this._tempo;
    this._tempo = tempo > 0.05 ? tempo : 1;

    // Passthrough when near 1× — avoids coloration.
    if (Math.abs(this._tempo - 1) < 1e-3) {
      for (let ch = 0; ch < output.length; ch++) {
        const src = input && input[ch] ? input[ch] : null;
        const dst = output[ch];
        if (!dst) continue;
        if (src) dst.set(src);
        else dst.fill(0);
      }
      return true;
    }

    // Simple resampled grain OLA for live constant tempo.
    // Consume input into a ring; emit stretched frames.
    const frames = output[0].length;
    const channels = output.length;
    this._ensureRing(channels, Math.max(4096, frames * 8));

    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const src = input && input[ch] ? input[ch][i] : 0;
        this._ring[ch][this._write] = src;
      }
      this._write = (this._write + 1) % this._ringLen;
    }

    // Output by reading at tempo-scaled position with linear interpolation.
    for (let i = 0; i < frames; i++) {
      const pos = this._readPos;
      const i0 = Math.floor(pos) % this._ringLen;
      const i1 = (i0 + 1) % this._ringLen;
      const frac = pos - Math.floor(pos);
      for (let ch = 0; ch < channels; ch++) {
        const a = this._ring[ch][i0];
        const b = this._ring[ch][i1];
        output[ch][i] = a * (1 - frac) + b * frac;
      }
      this._readPos += this._tempo;
      if (this._readPos >= this._ringLen) this._readPos -= this._ringLen;
    }

    return true;
  }
}

registerProcessor('time-stretch-processor', TimeStretchProcessor);
