import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEmscriptenModule } from './emscriptenLoader';
import {
  _resetMediaEngineLoadStateForTests,
  __setMediaEngineKillSwitchForTests,
  loadMediaEngineModule,
  MEDIA_ENGINE_MODULE,
} from './mediaEngine';
import { TIME_STRETCH_HOP, wasmRemapPlanar } from './timeStretch';
import { remapClipAudioBuffer } from '../audio/remapAudio';
import { cycleDurationForClip } from '../timeline/timeRemap';

const WASM_BASE = pathToFileURL(path.resolve(process.cwd(), 'public/wasm') + path.sep).href;
const RATE = 44100;

type EngineModule = NonNullable<Awaited<ReturnType<typeof loadMediaEngineModule>>> & {
  _time_stretch_remap(...args: number[]): number;
  _time_stretch_session_process(...args: number[]): number;
  HEAPU8: Uint8Array;
};

function sine(hz: number, frames: number, amp = 0.5): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

function offsets(outFrames: number, tempo: number): Float64Array {
  const hops = Math.ceil(outFrames / TIME_STRETCH_HOP) + 1;
  return Float64Array.from({ length: hops }, (_, h) => h * TIME_STRETCH_HOP * tempo);
}

function zeroCrossingHz(x: Float32Array, lo: number, hi: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = lo + 1; i < hi; i++) {
    if (x[i - 1]! < 0 && x[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  return count < 2 ? 0 : ((count - 1) * RATE) / (last - first);
}

/** The whole-buffer `time_stretch_remap`, called directly: the reference the session must equal. */
function withHeapCopy(mod: EngineModule, planar: Float32Array, inFrames: number, offs: Float64Array, outFrames: number) {
  const inPtr = mod._malloc(planar.byteLength);
  const offPtr = mod._malloc(offs.byteLength);
  const outPtr = mod._malloc(outFrames * 2 * 4);
  try {
    new Float32Array(mod.HEAPU8.buffer, inPtr, planar.length).set(planar);
    new Float64Array(mod.HEAPU8.buffer, offPtr, offs.length).set(offs);
    expect(mod._time_stretch_remap(inPtr, inFrames, 2, offPtr, offs.length, TIME_STRETCH_HOP, -1, outPtr, outFrames)).toBe(0);
    return new Float32Array(mod.HEAPU8.buffer, outPtr, outFrames * 2).slice();
  } finally {
    mod._free(inPtr);
    mod._free(offPtr);
    mod._free(outPtr);
  }
}

function fakeAudioBuffer(channels: Float32Array[]): AudioBuffer {
  return {
    sampleRate: RATE,
    numberOfChannels: channels.length,
    length: channels[0]!.length,
    duration: channels[0]!.length / RATE,
    getChannelData: (c: number) => channels[c]!,
  } as unknown as AudioBuffer;
}

const fakeCtx = {
  createBuffer(channels: number, frames: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return {
      sampleRate,
      numberOfChannels: channels,
      length: frames,
      getChannelData: (c: number) => data[c]!,
      copyToChannel: (src: Float32Array, c: number) => data[c]!.set(src),
    };
  },
} as unknown as BaseAudioContext;

/** One second of 440 Hz, slowed to half speed by a flat rate curve. */
const SLOW_CLIP = {
  trimStart: 0,
  trimEnd: 1,
  duration: 1,
  playbackRate: 1,
  automation: {
    playbackRate: [
      { t: 0, value: 0.5 },
      { t: 2, value: 0.5 },
    ],
  },
};

describe('time stretch (media-engine WASM)', () => {
  let mod: EngineModule;

  beforeEach(async () => {
    _resetMediaEngineLoadStateForTests();
    mod = (await loadMediaEngineModule({ baseUrl: WASM_BASE })) as EngineModule;
    expect(mod).not.toBeNull();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetMediaEngineLoadStateForTests();
  });

  it('reproduces the input bit for bit at rate 1', async () => {
    const frames = RATE / 2;
    const planar = new Float32Array(frames * 2);
    planar.set(sine(440, frames), 0);
    planar.set(sine(1000, frames, 0.25), frames);
    const out = await wasmRemapPlanar(planar, frames, 2, offsets(frames, 1), frames);
    expect(out).not.toBeNull();
    expect(out!.every((v, i) => v === planar[i])).toBe(true);
  });

  it('keeps pitch while slowing down', async () => {
    const inFrames = RATE;
    const outFrames = RATE * 2;
    const out = await wasmRemapPlanar(sine(440, inFrames), inFrames, 1, offsets(outFrames, 0.5), outFrames);
    expect(out).not.toBeNull();
    expect(zeroCrossingHz(out!, 2048, outFrames - 2048)).toBeCloseTo(440, -1);
  });

  it('stays off under ?no_media_engine', async () => {
    __setMediaEngineKillSwitchForTests(true);
    const spy = vi.spyOn(mod, '_time_stretch_session_process');
    expect(await wasmRemapPlanar(sine(440, 4096), 4096, 1, offsets(4096, 1), 4096)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the JS stretch when _malloc fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(mod, '_malloc').mockReturnValue(0);
    const remap = vi.spyOn(mod, '_time_stretch_session_process');

    expect(await wasmRemapPlanar(sine(440, 4096), 4096, 1, offsets(4096, 1), 4096)).toBeNull();

    const out = await remapClipAudioBuffer(SLOW_CLIP, fakeAudioBuffer([sine(440, RATE)]), fakeCtx);
    expect(remap).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((args) => String(args[1] ?? args[0]).includes('allocation'))).toBe(true);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(Math.floor(cycleDurationForClip(SLOW_CLIP) * RATE));
    const data = out!.getChannelData(0);
    expect(data.some((v) => Math.abs(v) > 0.1)).toBe(true);
  });

  it('falls back to JS and retires the instance when the module traps', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(mod, '_time_stretch_session_process').mockImplementation(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });

    const out = await remapClipAudioBuffer(SLOW_CLIP, fakeAudioBuffer([sine(440, RATE)]), fakeCtx);
    expect(out).not.toBeNull();
    expect(out!.getChannelData(0).some((v) => Math.abs(v) > 0.1)).toBe(true);

    expect(getEmscriptenModule(MEDIA_ENGINE_MODULE)).toBeNull();
    const fresh = await loadMediaEngineModule({ baseUrl: WASM_BASE });
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(mod);
  });

  it('matches the whole-buffer remap bit for bit, chunk by chunk', async () => {
    const inFrames = RATE * 2;
    const planar = new Float32Array(inFrames * 2);
    planar.set(sine(220, inFrames), 0);
    planar.set(sine(330, inFrames, 0.3), inFrames);
    // A sweep from 0.6x to 1.4x, so every chunk reads a differently sized window.
    const outFrames = RATE * 2 - 777;
    const hops = Math.ceil(outFrames / TIME_STRETCH_HOP) + 1;
    const offs = new Float64Array(hops);
    for (let h = 1; h < hops; h++) offs[h] = offs[h - 1]! + TIME_STRETCH_HOP * (0.6 + (0.8 * h) / hops);

    const whole = withHeapCopy(mod, planar, inFrames, offs, outFrames);
    for (const chunkBlocks of [1, 5, 96]) {
      const chunked = await wasmRemapPlanar(planar, inFrames, 2, offs, outFrames, { chunkBlocks });
      expect(chunked).not.toBeNull();
      let mismatches = 0;
      for (let i = 0; i < whole.length; i++) if (whole[i] !== chunked![i]) mismatches++;
      expect(mismatches).toBe(0);
    }
  });

  it('keeps a 10 minute clip at 0.5x under 64 MB of WASM heap', async () => {
    // Ten minutes of 48 kHz stereo is 230 MB of f32; the session sees a
    // second of it at a time. Synthesis cost is what it is, so this runs a
    // quiet source (no similarity search) to keep the test quick.
    const rate = 48_000;
    const inFrames = rate * 600;
    const channels = 2;
    const planar = new Float32Array(inFrames * channels);
    const outFrames = inFrames * 2;
    const hops = Math.ceil(outFrames / TIME_STRETCH_HOP) + 1;
    const offs = Float64Array.from({ length: hops }, (_, h) => h * TIME_STRETCH_HOP * 0.5);
    let peak = 0;
    const out = await wasmRemapPlanar(planar, inFrames, channels, offs, outFrames, {
      onHeapBytes: (bytes) => {
        peak = Math.max(peak, bytes);
      },
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(outFrames * channels);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(64 * 1024 * 1024);
    expect(mod.HEAPU8.byteLength).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);
});
