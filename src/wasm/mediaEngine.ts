/**
 * Lazy loader + typed bindings for the media-engine WASM module
 * (timeline PCM mix: polyphase resample, volume/pan curves, fades).
 *
 * The mix streams: `openTimelineMixStream` pulls fixed-size chunks through
 * `mix_timeline_audio_range`, uploading only the source frames each chunk
 * reads, so a 2-hour timeline never needs a full-length PCM buffer.
 *
 * With insert effects or lane buses the stream drives a stateful fx session
 * instead (`mediaEngineSession.ts`), which also runs the bus graph — lane
 * chains, sidechain ducks, the master chain, loudness gain, final limiter
 * and the output meter.
 *
 * Feature gracefully disables when the module fails to load (no crash);
 * export premix falls back to OfflineAudioContext.
 */

import {
  CS_STATUS,
  describeStatus,
  getEmscriptenLoadFailure,
  getEmscriptenModule,
  loadEmscriptenModule,
  withHeap,
  _resetEmscriptenModuleForTests,
} from './emscriptenLoader';
import type { Keyframe } from '../utils/keyframes';
import type { ClipAudioEffects, MasterLimiterSettings } from '../utils/audioEffects';
import type { BusGraphPlan } from '../audio/fxGraph';
import {
  createBusSession,
  createFxSession,
  decodeMeterReading,
  type FxSession,
  type MediaEngineWasmModule as WasmModule,
  type MixMeterReading,
} from './mediaEngineSession';
import {
  MEDIA_ENGINE_CHANNELS,
  MIX_METER,
  MIX_ENTRY_FX_STRIDE,
  MIX_ENTRY_STRIDE,
  MIX_FLAG_EFFECTS,
  MIX_FLAG_LINEAR_RESAMPLE,
  MIX_FX_STRIDE,
  MIX_KEY_STRIDE,
  MIX_SLICE_STRIDE,
  MIX_SOURCE_MARGIN_FRAMES,
  packAudioEffectRows,
  packKeyframes,
  packLimiterRow,
  sanitizedRate,
} from './mediaEngineLayout';

export { decodeMeterReading, type MixMeterReading } from './mediaEngineSession';
export {
  MEDIA_ENGINE_CHANNELS,
  MIX_BUS_FLAG_METER,
  MIX_BUS_STRIDE,
  MIX_METER,
  MIX_ENTRY_FX_STRIDE,
  MIX_ENTRY_STRIDE,
  MIX_FLAG_EFFECTS,
  MIX_FLAG_LINEAR_RESAMPLE,
  MIX_FX_STRIDE,
  MIX_KEY_STRIDE,
  MIX_SLICE_STRIDE,
  MIX_SOURCE_MARGIN_FRAMES,
  packAudioEffectRows,
  packLimiterRow,
} from './mediaEngineLayout';

/** Default stream chunk: 240 AAC-LC frames (5.12 s at 48 kHz). */
export const MEDIA_ENGINE_CHUNK_FRAMES = 1024 * 240;
/** Kill switch: `?no_media_engine` keeps OfflineAudioContext as the mixer. */
export const MEDIA_ENGINE_KILL_PARAM = 'no_media_engine';
/** Debug: `?media_engine_resampler=linear` swaps polyphase sinc for linear. */
export const MEDIA_ENGINE_RESAMPLER_PARAM = 'media_engine_resampler';

export interface ClipPcm {
  sampleRate: number;
  /**
   * Planar channel data (1 = mono, 2 = stereo; extra channels are ignored).
   * `AudioBuffer.getChannelData` views work as-is — no interleaving copy.
   */
  channelData: Float32Array[];
}

export interface MediaEngineMixEntry {
  clipId: string;
  timelineStart: number;
  duration: number;
  bufferOffset: number;
  /** Linear gain when there is no volume curve (fades multiply on top). */
  volume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  playbackRate?: number;
  /** Absolute gain keyframes (clip-local seconds); replaces `volume` when set. */
  volumeAutomation?: Keyframe[];
  /** Stereo pan keyframes (−1 L … +1 R); centred when empty. */
  panAutomation?: Keyframe[];
  /** Insert chain (EQ → compressor), run after resample and before the volume curve. */
  effects?: ClipAudioEffects;
  /** Lane bus (`BusGraphPlan.laneIndex`) with the `bus` option; absent = the master sum. */
  bus?: number;
}

export interface MixTimelineResult {
  sampleRate: number;
  channels: number;
  frames: Float32Array;
}

/** Per-entry PCM provider: decode lazily, drop PCM once an entry has played. */
export interface ClipPcmProvider {
  /**
   * PCM for `schedule[index]`, requested once, when the entry first falls
   * inside a chunk. `null` skips the entry; a throw aborts the stream.
   */
  acquire(index: number): Promise<ClipPcm | null> | ClipPcm | null;
  /** Every frame of `schedule[index]` has been mixed; its PCM is no longer read. */
  release?(index: number): void;
}

/** Where the stream gets clip PCM: a map by clip id, or a provider. */
export type ClipPcmSource = Record<string, ClipPcm> | ClipPcmProvider;

function isPcmProvider(source: ClipPcmSource): source is ClipPcmProvider {
  return typeof (source as ClipPcmProvider).acquire === 'function';
}

export interface TimelineMixStreamOptions {
  sampleRate?: number;
  channels?: number;
  /** Timeline length; defaults to the end of the last entry. */
  durationSec?: number;
  /** Output frames per `next()` (default `MEDIA_ENGINE_CHUNK_FRAMES`). */
  chunkFrames?: number;
  baseUrl?: string;
  /** Defaults to polyphase unless `?media_engine_resampler=linear`. */
  resampler?: 'polyphase' | 'linear';
  /** Look-ahead limiter on the mix bus; omitted / disabled = none. Ignored with `bus`. */
  limiter?: MasterLimiterSettings | null;
  /**
   * Lane buses, master chain, output gain and final stage
   * (`planBusGraph`). Entries route with `MediaEngineMixEntry.bus`.
   */
  bus?: BusGraphPlan | null;
  /** Run the BS.1770 meter on the output (`TimelineMixStream.readMeters`). */
  meter?: boolean;
}

export interface TimelineMixChunk {
  /** Absolute timeline frame of `frames[0]`. */
  startFrame: number;
  frameCount: number;
  /** Interleaved PCM. Reused by the next `next()` call — copy to keep it. */
  frames: Float32Array;
}


/** Module name shared with `timeStretch.ts` (one module, one heap). */
export const MEDIA_ENGINE_MODULE = 'media_engine';
export const MEDIA_ENGINE_FACTORY = 'createMediaEngineModule';

let testKillOverride: boolean | null = null;
let lastMixBackend: 'wasm' | 'unavailable' | 'disabled' | null = null;

function loadedModule(): WasmModule | null {
  return getEmscriptenModule<WasmModule>(MEDIA_ENGINE_MODULE);
}

function currentSearch(): string {
  return typeof location !== 'undefined' ? location.search : '';
}

export function isMediaEngineMixEnabled(search: string = currentSearch()): boolean {
  if (testKillOverride !== null) return !testKillOverride;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return !params.has(MEDIA_ENGINE_KILL_PARAM);
}

/** True once the module has loaded and the kill switch is off (sync). */
export function isMediaEngineReady(): boolean {
  return loadedModule() !== null && isMediaEngineMixEnabled();
}

function resamplerFlags(choice: TimelineMixStreamOptions['resampler']): number {
  if (choice) return choice === 'linear' ? MIX_FLAG_LINEAR_RESAMPLE : 0;
  const params = new URLSearchParams(currentSearch().replace(/^\?/, ''));
  return params.get(MEDIA_ENGINE_RESAMPLER_PARAM) === 'linear' ? MIX_FLAG_LINEAR_RESAMPLE : 0;
}

export async function loadMediaEngineModule(options?: {
  baseUrl?: string;
}): Promise<WasmModule | null> {
  return loadEmscriptenModule<WasmModule>(MEDIA_ENGINE_MODULE, MEDIA_ENGINE_FACTORY, options);
}

export function _resetMediaEngineLoadStateForTests(): void {
  _resetEmscriptenModuleForTests(MEDIA_ENGINE_MODULE);
  testKillOverride = null;
  lastMixBackend = null;
}

export function __setMediaEngineKillSwitchForTests(disabled: boolean | null): void {
  testKillOverride = disabled;
}

export function getMediaEngineLoadFailure(): string | null {
  return getEmscriptenLoadFailure(MEDIA_ENGINE_MODULE);
}

export function getLastMediaEngineMixBackend(): typeof lastMixBackend {
  return lastMixBackend;
}

/** Current WASM linear-memory size in bytes (0 when not loaded). */
export function getMediaEngineHeapBytes(): number {
  return loadedModule()?.HEAPU8.buffer.byteLength ?? 0;
}

export function formatMediaEngineDiagnostics(): string {
  const enabled = isMediaEngineMixEnabled();
  const fail = getMediaEngineLoadFailure();
  const backend = lastMixBackend ?? 'idle';
  if (!enabled) return `mediaEngine: disabled (?${MEDIA_ENGINE_KILL_PARAM}); last mix: ${backend}`;
  if (fail) return `mediaEngine: unavailable (${fail}); last mix: ${backend}`;
  return `mediaEngine: enabled; last mix: ${backend}`;
}

interface EntryState {
  /** Output-frame span the C++ mixer visits for this entry: `[firstFrame, endFrame)`. */
  firstFrame: number;
  endFrame: number;
  /** undefined = not requested yet; null = skipped. */
  pcm: ClipPcm | null | undefined;
  released: boolean;
}


/**
 * Chunked timeline mix over the media-engine WASM. Obtain one from
 * `openTimelineMixStream`; `close()` when done (also on error).
 */
export class TimelineMixStream implements AsyncIterable<TimelineMixChunk> {
  readonly totalFrames: number;
  private position = 0;
  private closed = false;
  private readonly chunkOut: Float32Array;
  private readonly states: EntryState[];

  /** @internal Use `openTimelineMixStream`. */
  constructor(
    private readonly mod: WasmModule,
    private readonly schedule: MediaEngineMixEntry[],
    private readonly rows: Float64Array,
    private readonly keys: Float64Array,
    private readonly source: ClipPcmSource,
    readonly sampleRate: number,
    readonly channels: number,
    readonly chunkFrames: number,
    durationSec: number,
    private readonly flags: number,
    private readonly fx: FxSession | null = null,
  ) {
    this.totalFrames = Math.max(1, Math.ceil(durationSec * sampleRate));
    this.chunkOut = new Float32Array(chunkFrames * channels);
    this.states = schedule.map((entry) => ({
      firstFrame: Math.floor(entry.timelineStart * sampleRate),
      endFrame: Math.ceil((entry.timelineStart + entry.duration) * sampleRate) + 1,
      pcm: undefined,
      released: false,
    }));
  }

  /** Mix the next chunk, or null once `totalFrames` have been produced. */
  async next(): Promise<TimelineMixChunk | null> {
    if (this.closed) throw new Error('TimelineMixStream is closed');
    if (this.position >= this.totalFrames) return null;

    const begin = this.position;
    const frameCount = Math.min(this.chunkFrames, this.totalFrames - begin);
    const end = begin + frameCount;
    // An fx session mixes entries `latency` frames ahead of the output (the
    // limiter's look-ahead) and primes that window on the first chunk.
    const lead = this.fx?.latency ?? 0;
    const busBegin = begin === 0 ? 0 : begin + lead;
    const busEnd = end + lead;

    const active: number[] = [];
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[i]!;
      if (state.endFrame <= busBegin) {
        this.release(i);
      } else if (state.firstFrame < busEnd) {
        active.push(i);
      }
    }
    for (const i of active) {
      const state = this.states[i]!;
      if (state.pcm === undefined) state.pcm = await this.acquire(i);
      if (this.closed) throw new Error('TimelineMixStream closed while mixing');
    }

    this.mixRange(begin, frameCount, busBegin, busEnd, active);
    this.position = end;
    return { startFrame: begin, frameCount, frames: this.chunkOut.subarray(0, frameCount * this.channels) };
  }

  /**
   * The output meter so far (`meter` option), or null without one. Covers
   * every chunk produced; read after the last chunk for the whole programme.
   */
  readMeters(): MixMeterReading | null {
    const fx = this.fx;
    const mod = this.mod;
    if (this.closed || !fx || typeof mod._mix_fx_session_meters !== 'function') return null;
    const capacity = MIX_METER.laneGainReduction + fx.lanes;
    const values = withHeap(mod, (heap) => {
      const out = heap.alloc(capacity * 8);
      const n = mod._mix_fx_session_meters!(fx.handle, out, capacity);
      return n > 0 ? heap.readF64(out, n) : null;
    });
    return values ? decodeMeterReading(values) : null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TimelineMixChunk> {
    for (let chunk = await this.next(); chunk; chunk = await this.next()) yield chunk;
  }

  /** Destroy the fx session and release every PCM the stream still holds. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (let i = 0; i < this.states.length; i++) this.release(i);
    if (this.fx) this.mod._mix_fx_session_destroy?.(this.fx.handle);
  }

  private async acquire(index: number): Promise<ClipPcm | null> {
    const source = this.source;
    const pcm = isPcmProvider(source)
      ? await source.acquire(index)
      : source[this.schedule[index]!.clipId] ?? null;
    if (!pcm || pcm.channelData.length === 0 || !(pcm.sampleRate > 0)) return null;
    return pcm;
  }

  private release(index: number): void {
    const state = this.states[index]!;
    if (state.released || state.pcm === undefined) return;
    state.released = true;
    const hadPcm = state.pcm !== null;
    state.pcm = null;
    if (hadPcm && isPcmProvider(this.source)) this.source.release?.(index);
  }

  /**
   * Source frames `[first, last)` that output frames `[begin, end)` read for
   * entry `index`, with the resampler margin — the C++ side reads silence
   * outside the uploaded window, so this must cover every tap.
   */
  private sliceWindow(index: number, pcmFrames: number, pcmRate: number, begin: number, end: number): [number, number] {
    const state = this.states[index]!;
    const entry = this.schedule[index]!;
    const firstOf = Math.max(begin, state.firstFrame);
    const endOf = Math.min(end, state.endFrame);
    if (firstOf >= endOf) return [0, 0];
    const rate = sanitizedRate(entry.playbackRate);
    const offset = Math.max(0, entry.bufferOffset);
    const pos = (of: number) => (offset + (of / this.sampleRate - entry.timelineStart) * rate) * pcmRate;
    const first = Math.max(0, Math.floor(pos(firstOf)) - MIX_SOURCE_MARGIN_FRAMES);
    const last = Math.min(pcmFrames, Math.floor(pos(endOf - 1)) + MIX_SOURCE_MARGIN_FRAMES + 1);
    return first < last ? [first, last] : [0, 0];
  }

  private mixRange(begin: number, frameCount: number, busBegin: number, busEnd: number, active: number[]): void {
    type Upload = { index: number; pcm: ClipPcm; planes: number; frames: number; first: number; last: number };
    const uploads: Upload[] = [];
    let pcmFloats = 0;
    for (const index of active) {
      const pcm = this.states[index]!.pcm;
      if (!pcm) continue;
      const planes = Math.min(2, pcm.channelData.length);
      let frames = Infinity;
      for (let c = 0; c < planes; c++) frames = Math.min(frames, pcm.channelData[c]!.length);
      if (!(frames > 0)) continue;
      const [first, last] = this.sliceWindow(index, frames, pcm.sampleRate, busBegin, busEnd);
      // An insert chain must hear every frame of its entry (silence included)
      // or its state would depend on the chunking: keep an empty slice.
      if (first >= last && !this.fx) continue;
      uploads.push({ index, pcm, planes, frames, first, last });
      pcmFloats += (last - first) * planes;
    }

    // Everything a chunk needs is uploaded into one scope and freed after the
    // call, so the stream holds no heap between chunks.
    const mod = this.mod;
    const fx = this.fx;
    const stride = fx ? MIX_ENTRY_FX_STRIDE : MIX_ENTRY_STRIDE;
    const outFloats = frameCount * this.channels;
    const rc = withHeap(mod, (heap) => {
      const out = heap.alloc(outFloats * 4);
      const pcm = heap.alloc(pcmFloats * 4);
      const slices = heap.alloc(uploads.length * MIX_SLICE_STRIDE * 4);
      const rows = heap.alloc(uploads.length * stride * 8);
      const keys = heap.f64(this.keys);
      const meta = heap.i32View(slices, uploads.length * MIX_SLICE_STRIDE);
      const pcmView = heap.f32View(pcm, pcmFloats);
      const rowView = heap.f64View(rows, uploads.length * stride);

      let cursor = 0;
      for (let k = 0; k < uploads.length; k++) {
        const u = uploads[k]!;
        const len = u.last - u.first;
        const m = k * MIX_SLICE_STRIDE;
        meta[m] = cursor;
        meta[m + 1] = len;
        meta[m + 2] = u.planes;
        meta[m + 3] = u.pcm.sampleRate | 0;
        meta[m + 4] = u.first;
        meta[m + 5] = u.frames;
        for (let c = 0; c < u.planes; c++) {
          pcmView.set(u.pcm.channelData[c]!.subarray(u.first, u.last), cursor);
          cursor += len;
        }
        rowView.set(this.rows.subarray(u.index * stride, (u.index + 1) * stride), k * stride);
        rowView[k * stride] = k;
      }

      const keyCount = this.keys.length / MIX_KEY_STRIDE;
      const status = fx
        ? mod._mix_fx_session_range!(
            fx.handle,
            out,
            frameCount,
            begin,
            pcm,
            pcmFloats,
            slices,
            uploads.length,
            rows,
            uploads.length,
            keys,
            keyCount,
            this.flags | MIX_FLAG_EFFECTS,
          )
        : mod._mix_timeline_audio_range(
            out,
            frameCount,
            begin,
            this.sampleRate,
            this.channels,
            pcm,
            pcmFloats,
            slices,
            uploads.length,
            rows,
            uploads.length,
            keys,
            keyCount,
            this.flags,
          );
      if (status === CS_STATUS.OK) this.chunkOut.set(heap.f32View(out, outFloats));
      return status;
    });
    if (rc === null) {
      lastMixBackend = 'unavailable';
      throw new Error(`media engine out of memory (${pcmFloats * 4} bytes of source PCM)`);
    }
    if (rc !== CS_STATUS.OK) {
      lastMixBackend = 'unavailable';
      throw new Error(`media engine mix failed (${describeStatus(rc)})`);
    }
  }
}

/**
 * Open a chunked mix of `schedule`. Returns null when WASM is disabled or
 * unavailable (callers fall back to OfflineAudioContext).
 */
export async function openTimelineMixStream(
  schedule: MediaEngineMixEntry[],
  source: ClipPcmSource,
  options?: TimelineMixStreamOptions,
): Promise<TimelineMixStream | null> {
  if (!isMediaEngineMixEnabled()) {
    lastMixBackend = 'disabled';
    return null;
  }

  const mod = await loadMediaEngineModule({ baseUrl: options?.baseUrl });
  if (!mod) {
    lastMixBackend = 'unavailable';
    return null;
  }

  const sampleRate = options?.sampleRate ?? 48000;
  const channels = options?.channels ?? MEDIA_ENGINE_CHANNELS;
  const chunkFrames = Math.max(1, Math.floor(options?.chunkFrames ?? MEDIA_ENGINE_CHUNK_FRAMES));
  if (channels !== 1 && channels !== 2) return null;
  if (!(sampleRate > 0)) return null;

  let durationSec = options?.durationSec;
  if (durationSec == null) {
    durationSec = 0;
    for (const entry of schedule) {
      durationSec = Math.max(durationSec, entry.timelineStart + entry.duration);
    }
  }

  // Insert chains, buses and the bus limiter need the stateful fx session;
  // without any of them the stream stays on the stateless, bit-exact legacy
  // entry point.
  const fxValues: number[] = [];
  const fxRanges = schedule.map((entry) => {
    const first = fxValues.length / MIX_FX_STRIDE;
    const packed = packAudioEffectRows(entry.effects);
    for (const v of packed) fxValues.push(v);
    return [first, packed.length / MIX_FX_STRIDE] as const;
  });
  const busFirst = fxValues.length / MIX_FX_STRIDE;
  const bus = options?.bus && (options.bus.processing || options.meter) ? options.bus : null;
  const meter = Boolean(options?.meter && bus);
  if (bus) {
    for (const v of bus.effects) fxValues.push(v);
  } else {
    for (const v of packLimiterRow(options?.limiter)) fxValues.push(v);
  }
  const useFx = fxValues.length > 0 || bus !== null;
  if (useFx && typeof mod._mix_fx_session_create !== 'function') {
    // A stale cached module without the fx exports: no inserts rather than wrong ones.
    lastMixBackend = 'unavailable';
    return null;
  }
  if (bus && typeof mod._mix_bus_session_create !== 'function') {
    lastMixBackend = 'unavailable';
    return null;
  }
  const stride = useFx ? MIX_ENTRY_FX_STRIDE : MIX_ENTRY_STRIDE;

  const keyValues: number[] = [];
  const rows = new Float64Array(schedule.length * stride);
  for (let i = 0; i < schedule.length; i++) {
    const e = schedule[i]!;
    const base = i * stride;
    rows[base + 0] = -1; // slice index, patched per chunk
    rows[base + 1] = e.timelineStart;
    rows[base + 2] = e.duration;
    rows[base + 3] = e.bufferOffset;
    rows[base + 4] = e.volume;
    rows[base + 5] = e.audioFadeIn;
    rows[base + 6] = e.audioFadeOut;
    rows[base + 7] = sanitizedRate(e.playbackRate);
    rows[base + 8] = keyValues.length / MIX_KEY_STRIDE;
    rows[base + 9] = packKeyframes(keyValues, e.volumeAutomation);
    rows[base + 10] = keyValues.length / MIX_KEY_STRIDE;
    rows[base + 11] = packKeyframes(keyValues, e.panAutomation);
    if (useFx) {
      rows[base + 12] = fxRanges[i]![0];
      rows[base + 13] = fxRanges[i]![1];
      rows[base + 14] = i; // filter-state slot: stable across chunks
      rows[base + 15] = bus && e.bus != null ? e.bus : -1;
    }
  }
  // A heap that cannot hold one chunk's output will not mix: fall back now
  // rather than on the first chunk.
  if (!withHeap(mod, (heap) => heap.alloc(chunkFrames * channels * 4) > 0)) {
    lastMixBackend = 'unavailable';
    return null;
  }

  let fx: FxSession | null = null;
  if (useFx) {
    const handle = bus
      ? createBusSession(mod, sampleRate, channels, schedule.length, fxValues, busFirst, bus, meter)
      : createFxSession(mod, sampleRate, channels, schedule.length, fxValues, busFirst);
    if (!handle) {
      lastMixBackend = 'unavailable';
      return null;
    }
    fx = { handle, latency: mod._mix_fx_session_latency!(handle), lanes: bus ? bus.laneTrackIds.length : 0 };
  }

  lastMixBackend = 'wasm';
  return new TimelineMixStream(
    mod,
    schedule,
    rows,
    Float64Array.from(keyValues),
    source,
    sampleRate,
    channels,
    chunkFrames,
    durationSec,
    resamplerFlags(options?.resampler),
    fx,
  );
}



/**
 * Mix scheduled clip PCM into one interleaved buffer (streams internally).
 * Returns null when WASM is missing, disabled, or the mix call fails.
 */
export async function mixTimelineAudio(
  schedule: MediaEngineMixEntry[],
  pcmByClipId: Record<string, ClipPcm>,
  options?: TimelineMixStreamOptions,
): Promise<MixTimelineResult | null> {
  const stream = await openTimelineMixStream(schedule, pcmByClipId, options);
  if (!stream) return null;
  try {
    if (schedule.length > 0 && !schedule.some((entry) => pcmByClipId[entry.clipId])) {
      lastMixBackend = 'unavailable';
      return null;
    }
    const frames = new Float32Array(stream.totalFrames * stream.channels);
    for await (const chunk of stream) {
      frames.set(chunk.frames, chunk.startFrame * stream.channels);
    }
    return { sampleRate: stream.sampleRate, channels: stream.channels, frames };
  } catch (err) {
    console.warn('[mediaEngine] mix failed:', err);
    lastMixBackend = 'unavailable';
    return null;
  } finally {
    stream.close();
  }
}

/** Planar views of an AudioBuffer's first two channels (no copy). */
export function audioBufferToClipPcm(buffer: AudioBuffer): ClipPcm {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));
  return { sampleRate: buffer.sampleRate, channelData };
}

/**
 * True when a schedule has to premix on OfflineAudioContext. The loaded media
 * engine evaluates volume/pan curves itself, so this is false once it is
 * ready; before that (or with `?no_media_engine` / a failed load) curves still
 * need the Web Audio graph.
 */
export function scheduleNeedsOfflineAudioMix(
  entries: Array<{
    volumeAutomation?: unknown[];
    panAutomation?: unknown[];
  }>,
): boolean {
  if (isMediaEngineReady()) return false;
  return entries.some(
    (e) => (e.volumeAutomation?.length ?? 0) > 0 || (e.panAutomation?.length ?? 0) > 0,
  );
}
