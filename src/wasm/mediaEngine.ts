/**
 * Lazy loader + typed bindings for the media-engine WASM module
 * (timeline PCM mix: polyphase resample, volume/pan curves, fades).
 *
 * The mix streams: `openTimelineMixStream` pulls fixed-size chunks through
 * `mix_timeline_audio_range`, uploading only the source frames each chunk
 * reads, so a 2-hour timeline never needs a full-length PCM buffer.
 *
 * Feature gracefully disables when the module fails to load (no crash);
 * export premix falls back to OfflineAudioContext.
 */

import { getWasmPublicBaseUrl } from './audioAnalysis';
import { readWasmBinaryIfFileUrl, type EmscriptenFactory } from './emscriptenLoader';
import { sortKeyframes, type Keyframe } from '../utils/keyframes';

export const MEDIA_ENGINE_CHANNELS = 2;
/** f64 fields per packed mix entry (`MIX_ENTRY_STRIDE` in audio_mix.h). */
export const MIX_ENTRY_STRIDE = 12;
/** i32 fields per source slice (`MIX_SLICE_STRIDE`). */
export const MIX_SLICE_STRIDE = 6;
/** f64 fields per packed keyframe (`MIX_KEY_STRIDE`). */
export const MIX_KEY_STRIDE = 7;
/** Source frames uploaded beyond what a chunk reads (`MIX_SOURCE_MARGIN_FRAMES`). */
export const MIX_SOURCE_MARGIN_FRAMES = 64;
/** `MIX_FLAG_LINEAR_RESAMPLE`: phase-1 linear interpolation (debug / fallback). */
export const MIX_FLAG_LINEAR_RESAMPLE = 1;
/** Default stream chunk: 240 AAC-LC frames (5.12 s at 48 kHz). */
export const MEDIA_ENGINE_CHUNK_FRAMES = 1024 * 240;
/** Kill switch: `?no_media_engine` keeps OfflineAudioContext as the mixer. */
export const MEDIA_ENGINE_KILL_PARAM = 'no_media_engine';
/** Debug: `?media_engine_resampler=linear` swaps polyphase sinc for linear. */
export const MEDIA_ENGINE_RESAMPLER_PARAM = 'media_engine_resampler';

/** `MIX_EASING_*` code; anything unrecognised is a bezier, like `applyEasing`. */
function easingCode(easing: Keyframe['easing']): number {
  switch (easing?.type ?? 'linear') {
    case 'linear':
      return 0;
    case 'bellCurveSmooth':
      return 2;
    case 'bellCurveSharp':
      return 3;
    default:
      return 1;
  }
}

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
}

export interface TimelineMixChunk {
  /** Absolute timeline frame of `frames[0]`. */
  startFrame: number;
  frameCount: number;
  /** Interleaved PCM. Reused by the next `next()` call — copy to keep it. */
  frames: Float32Array;
}

interface WasmModule {
  _mix_timeline_audio_range(
    outPtr: number,
    outFrames: number,
    startFrame: number,
    outSampleRate: number,
    outChannels: number,
    pcmPtr: number,
    slicesPtr: number,
    sliceCount: number,
    entriesPtr: number,
    entryCount: number,
    keyframesPtr: number,
    keyframeCount: number,
    flags: number,
  ): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

type ModuleFactory = EmscriptenFactory<WasmModule>;

let loadPromise: Promise<WasmModule | null> | null = null;
let loadedModule: WasmModule | null = null;
let loadFailedReason: string | null = null;
let testKillOverride: boolean | null = null;
let lastMixBackend: 'wasm' | 'unavailable' | 'disabled' | null = null;

function resolveAssetUrl(fileName: string, baseUrl?: string): string {
  const root = baseUrl
    ? baseUrl.endsWith('/')
      ? baseUrl
      : `${baseUrl}/`
    : getWasmPublicBaseUrl();
  return new URL(fileName, root).href;
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
  return loadedModule !== null && isMediaEngineMixEnabled();
}

function resamplerFlags(choice: TimelineMixStreamOptions['resampler']): number {
  if (choice) return choice === 'linear' ? MIX_FLAG_LINEAR_RESAMPLE : 0;
  const params = new URLSearchParams(currentSearch().replace(/^\?/, ''));
  return params.get(MEDIA_ENGINE_RESAMPLER_PARAM) === 'linear' ? MIX_FLAG_LINEAR_RESAMPLE : 0;
}

export async function loadMediaEngineModule(options?: {
  baseUrl?: string;
}): Promise<WasmModule | null> {
  if (loadFailedReason) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const jsUrl = resolveAssetUrl('media_engine.js', options?.baseUrl);
      const wasmUrl = resolveAssetUrl('media_engine.wasm', options?.baseUrl);
      const mod = (await import(/* @vite-ignore */ jsUrl)) as { default: ModuleFactory };
      const factory = mod.default;
      if (typeof factory !== 'function') {
        throw new Error('media_engine module factory missing');
      }
      const wasmBinary = await readWasmBinaryIfFileUrl(wasmUrl);
      loadedModule = await factory({
        ...(wasmBinary ? { wasmBinary } : {}),
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) return wasmUrl;
          return resolveAssetUrl(path, options?.baseUrl);
        },
      });
      return loadedModule;
    } catch (err) {
      loadFailedReason = err instanceof Error ? err.message : String(err);
      console.warn(
        '[mediaEngine] WASM load failed — timeline mix stays on OfflineAudioContext:',
        loadFailedReason,
      );
      return null;
    }
  })();

  return loadPromise;
}

export function _resetMediaEngineLoadStateForTests(): void {
  loadPromise = null;
  loadedModule = null;
  loadFailedReason = null;
  testKillOverride = null;
  lastMixBackend = null;
}

export function __setMediaEngineKillSwitchForTests(disabled: boolean | null): void {
  testKillOverride = disabled;
}

export function getMediaEngineLoadFailure(): string | null {
  return loadFailedReason;
}

export function getLastMediaEngineMixBackend(): typeof lastMixBackend {
  return lastMixBackend;
}

/** Current WASM linear-memory size in bytes (0 when not loaded). */
export function getMediaEngineHeapBytes(): number {
  return loadedModule?.HEAPU8.buffer.byteLength ?? 0;
}

export function formatMediaEngineDiagnostics(): string {
  const enabled = isMediaEngineMixEnabled();
  const fail = loadFailedReason;
  const backend = lastMixBackend ?? 'idle';
  if (!enabled) return `mediaEngine: disabled (?${MEDIA_ENGINE_KILL_PARAM}); last mix: ${backend}`;
  if (fail) return `mediaEngine: unavailable (${fail}); last mix: ${backend}`;
  return `mediaEngine: enabled; last mix: ${backend}`;
}

/** Append `keys` (sorted like `sampleKeyframes`) as packed rows; returns the row count. */
function packKeyframes(out: number[], keys: Keyframe[] | undefined): number {
  if (!keys?.length) return 0;
  for (const key of sortKeyframes(keys)) {
    const easing = key.easing;
    out.push(
      key.t,
      key.value,
      easingCode(easing),
      easing?.x1 ?? 0,
      easing?.y1 ?? 0,
      easing?.x2 ?? 1,
      easing?.y2 ?? 1,
    );
  }
  return keys.length;
}

function sanitizedRate(rate: number | undefined): number {
  return Number.isFinite(rate) && (rate ?? 0) > 0 ? rate! : 1;
}

interface EntryState {
  /** Output-frame span the C++ mixer visits for this entry: `[firstFrame, endFrame)`. */
  firstFrame: number;
  endFrame: number;
  /** undefined = not requested yet; null = skipped. */
  pcm: ClipPcm | null | undefined;
  released: boolean;
}

/** Heap regions owned by one stream. */
interface StreamBuffers {
  out: number;
  keys: number;
  rows: number;
  slices: number;
  pcm: number;
  pcmCapacityFloats: number;
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
    private readonly keyframeCount: number,
    private readonly source: ClipPcmSource,
    private readonly buffers: StreamBuffers,
    readonly sampleRate: number,
    readonly channels: number,
    readonly chunkFrames: number,
    durationSec: number,
    private readonly flags: number,
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

    const active: number[] = [];
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[i]!;
      if (state.endFrame <= begin) {
        this.release(i);
      } else if (state.firstFrame < end) {
        active.push(i);
      }
    }
    for (const i of active) {
      const state = this.states[i]!;
      if (state.pcm === undefined) state.pcm = await this.acquire(i);
      if (this.closed) throw new Error('TimelineMixStream closed while mixing');
    }

    this.mixRange(begin, frameCount, active);
    this.position = end;
    return { startFrame: begin, frameCount, frames: this.chunkOut.subarray(0, frameCount * this.channels) };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TimelineMixChunk> {
    for (let chunk = await this.next(); chunk; chunk = await this.next()) yield chunk;
  }

  /** Free WASM buffers and release every PCM the stream still holds. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (let i = 0; i < this.states.length; i++) this.release(i);
    const { out, keys, rows, slices, pcm } = this.buffers;
    for (const ptr of [out, keys, rows, slices, pcm]) if (ptr) this.mod._free(ptr);
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

  private mixRange(begin: number, frameCount: number, active: number[]): void {
    const end = begin + frameCount;
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
      const [first, last] = this.sliceWindow(index, frames, pcm.sampleRate, begin, end);
      if (first >= last) continue;
      uploads.push({ index, pcm, planes, frames, first, last });
      pcmFloats += (last - first) * planes;
    }

    this.ensurePcmCapacity(pcmFloats);
    const mod = this.mod;
    const heapF32 = mod.HEAPF32;
    const heap32 = mod.HEAP32;
    const heapF64 = new Float64Array(mod.HEAPU8.buffer);
    const { out, keys, rows, slices, pcm } = this.buffers;

    let cursor = 0;
    for (let k = 0; k < uploads.length; k++) {
      const u = uploads[k]!;
      const len = u.last - u.first;
      const meta = (slices >> 2) + k * MIX_SLICE_STRIDE;
      heap32[meta] = cursor;
      heap32[meta + 1] = len;
      heap32[meta + 2] = u.planes;
      heap32[meta + 3] = u.pcm.sampleRate | 0;
      heap32[meta + 4] = u.first;
      heap32[meta + 5] = u.frames;
      for (let c = 0; c < u.planes; c++) {
        heapF32.set(u.pcm.channelData[c]!.subarray(u.first, u.last), (pcm >> 2) + cursor);
        cursor += len;
      }
      const row = (rows >> 3) + k * MIX_ENTRY_STRIDE;
      heapF64.set(this.rows.subarray(u.index * MIX_ENTRY_STRIDE, (u.index + 1) * MIX_ENTRY_STRIDE), row);
      heapF64[row] = k;
    }

    const rc = mod._mix_timeline_audio_range(
      out,
      frameCount,
      begin,
      this.sampleRate,
      this.channels,
      pcm,
      slices,
      uploads.length,
      rows,
      uploads.length,
      keys,
      this.keyframeCount,
      this.flags,
    );
    if (rc !== 0) {
      lastMixBackend = 'unavailable';
      throw new Error(`media engine mix failed (rc=${rc})`);
    }
    const outFloats = frameCount * this.channels;
    this.chunkOut.set(mod.HEAPF32.subarray(out >> 2, (out >> 2) + outFloats));
  }

  private ensurePcmCapacity(floats: number): void {
    if (floats <= this.buffers.pcmCapacityFloats) return;
    const capacity = Math.max(floats, Math.ceil(this.buffers.pcmCapacityFloats * 1.5));
    if (this.buffers.pcm) this.mod._free(this.buffers.pcm);
    this.buffers.pcm = 0;
    this.buffers.pcmCapacityFloats = 0;
    const ptr = this.mod._malloc(capacity * 4);
    if (!ptr) {
      lastMixBackend = 'unavailable';
      throw new Error(`media engine out of memory (${capacity * 4} bytes of source PCM)`);
    }
    this.buffers.pcm = ptr;
    this.buffers.pcmCapacityFloats = capacity;
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

  const keyValues: number[] = [];
  const rows = new Float64Array(schedule.length * MIX_ENTRY_STRIDE);
  for (let i = 0; i < schedule.length; i++) {
    const e = schedule[i]!;
    const base = i * MIX_ENTRY_STRIDE;
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
  }
  const keyframeCount = keyValues.length / MIX_KEY_STRIDE;

  const buffers: StreamBuffers = {
    out: mod._malloc(chunkFrames * channels * 4),
    keys: mod._malloc(Math.max(8, keyValues.length * 8)),
    rows: mod._malloc(Math.max(8, rows.byteLength)),
    slices: mod._malloc(Math.max(4, schedule.length * MIX_SLICE_STRIDE * 4)),
    pcm: 0,
    pcmCapacityFloats: 0,
  };
  // f64 views need 8-byte alignment (Emscripten's malloc guarantees it).
  if (!buffers.out || !buffers.keys || !buffers.rows || !buffers.slices || (buffers.keys | buffers.rows) & 7) {
    for (const ptr of [buffers.out, buffers.keys, buffers.rows, buffers.slices]) if (ptr) mod._free(ptr);
    lastMixBackend = 'unavailable';
    return null;
  }
  if (keyValues.length) new Float64Array(mod.HEAPU8.buffer).set(keyValues, buffers.keys >> 3);

  lastMixBackend = 'wasm';
  return new TimelineMixStream(
    mod,
    schedule,
    rows,
    keyframeCount,
    source,
    buffers,
    sampleRate,
    channels,
    chunkFrames,
    durationSec,
    resamplerFlags(options?.resampler),
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
