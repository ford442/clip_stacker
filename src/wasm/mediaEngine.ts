/**
 * Lazy loader + typed bindings for the media-engine WASM module
 * (timeline PCM mix / linear resample).
 *
 * Feature gracefully disables when the module fails to load (no crash);
 * export premix falls back to OfflineAudioContext.
 */

import { getWasmPublicBaseUrl } from './audioAnalysis';

export const MEDIA_ENGINE_CHANNELS = 2;
export const MIX_ENTRY_STRIDE = 8;
export const MIX_CLIP_STRIDE = 4;
/** Kill switch: `?no_media_engine` keeps OfflineAudioContext as the mixer. */
export const MEDIA_ENGINE_KILL_PARAM = 'no_media_engine';

export interface ClipPcm {
  sampleRate: number;
  channels: number;
  /** Interleaved f32 frames (length === frames * channels). */
  frames: Float32Array;
}

export interface MediaEngineMixEntry {
  clipId: string;
  timelineStart: number;
  duration: number;
  bufferOffset: number;
  volume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  playbackRate?: number;
}

export interface MixTimelineResult {
  sampleRate: number;
  channels: number;
  frames: Float32Array;
}

interface WasmModule {
  _mix_timeline_audio(
    outPtr: number,
    outFrames: number,
    outSampleRate: number,
    outChannels: number,
    pcmPtr: number,
    metaPtr: number,
    clipCount: number,
    entriesPtr: number,
    entryCount: number,
  ): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
  HEAP32: Int32Array;
}

type ModuleFactory = (opts?: { locateFile?: (path: string) => string }) => Promise<WasmModule>;

let loadPromise: Promise<WasmModule | null> | null = null;
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

export function isMediaEngineMixEnabled(
  search: string = typeof location !== 'undefined' ? location.search : '',
): boolean {
  if (testKillOverride !== null) return !testKillOverride;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return !params.has(MEDIA_ENGINE_KILL_PARAM);
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
      return await factory({
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) return wasmUrl;
          return resolveAssetUrl(path, options?.baseUrl);
        },
      });
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

export function formatMediaEngineDiagnostics(): string {
  const enabled = isMediaEngineMixEnabled();
  const fail = loadFailedReason;
  const backend = lastMixBackend ?? 'idle';
  if (!enabled) return `mediaEngine: disabled (?${MEDIA_ENGINE_KILL_PARAM}); last mix: ${backend}`;
  if (fail) return `mediaEngine: unavailable (${fail}); last mix: ${backend}`;
  return `mediaEngine: enabled; last mix: ${backend}`;
}

function uniqueClipIds(schedule: MediaEngineMixEntry[], pcmByClipId: Record<string, ClipPcm>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of schedule) {
    if (seen.has(entry.clipId)) continue;
    if (!pcmByClipId[entry.clipId]) continue;
    seen.add(entry.clipId);
    ids.push(entry.clipId);
  }
  return ids;
}

/**
 * Mix scheduled clip PCM into interleaved stereo f32.
 * Returns null when WASM is missing, disabled, or the mix call fails.
 */
export async function mixTimelineAudio(
  schedule: MediaEngineMixEntry[],
  pcmByClipId: Record<string, ClipPcm>,
  options?: {
    sampleRate?: number;
    durationSec?: number;
    channels?: number;
    baseUrl?: string;
  },
): Promise<MixTimelineResult | null> {
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
  if (channels !== 1 && channels !== 2) return null;
  if (sampleRate <= 0) return null;

  let durationSec = options?.durationSec;
  if (durationSec == null) {
    durationSec = 0;
    for (const entry of schedule) {
      durationSec = Math.max(durationSec, entry.timelineStart + entry.duration);
    }
  }
  const outFrames = Math.max(1, Math.ceil(durationSec * sampleRate));
  const clipIds = uniqueClipIds(schedule, pcmByClipId);
  if (schedule.length > 0 && clipIds.length === 0) {
    lastMixBackend = 'unavailable';
    return null;
  }

  const indexOf = new Map(clipIds.map((id, i) => [id, i]));
  const meta = new Int32Array(clipIds.length * MIX_CLIP_STRIDE);
  let pcmFloats = 0;
  for (let i = 0; i < clipIds.length; i++) {
    const clip = pcmByClipId[clipIds[i]!];
    if (!clip) continue;
    meta[i * MIX_CLIP_STRIDE + 0] = pcmFloats;
    const nch = Math.max(1, Math.min(2, clip.channels | 0));
    const frames = Math.floor(clip.frames.length / nch);
    meta[i * MIX_CLIP_STRIDE + 1] = frames;
    meta[i * MIX_CLIP_STRIDE + 2] = nch;
    meta[i * MIX_CLIP_STRIDE + 3] = clip.sampleRate | 0;
    pcmFloats += frames * nch;
  }

  const blob = new Float32Array(Math.max(1, pcmFloats));
  for (let i = 0; i < clipIds.length; i++) {
    const clip = pcmByClipId[clipIds[i]!];
    if (!clip) continue;
    const offset = meta[i * MIX_CLIP_STRIDE]!;
    const nch = meta[i * MIX_CLIP_STRIDE + 2]!;
    const frames = meta[i * MIX_CLIP_STRIDE + 1]!;
    blob.set(clip.frames.subarray(0, frames * nch), offset);
  }

  const entries = new Float32Array(schedule.length * MIX_ENTRY_STRIDE);
  for (let i = 0; i < schedule.length; i++) {
    const e = schedule[i]!;
    const clipIndex = indexOf.get(e.clipId) ?? -1;
    const base = i * MIX_ENTRY_STRIDE;
    const rate =
      Number.isFinite(e.playbackRate) && (e.playbackRate ?? 0) > 0 ? e.playbackRate! : 1;
    entries[base + 0] = clipIndex;
    entries[base + 1] = e.timelineStart;
    entries[base + 2] = e.duration;
    entries[base + 3] = e.bufferOffset;
    entries[base + 4] = e.volume;
    entries[base + 5] = e.audioFadeIn;
    entries[base + 6] = e.audioFadeOut;
    entries[base + 7] = rate;
  }

  const outPtr = mod._malloc(outFrames * channels * 4);
  const pcmPtr = mod._malloc(blob.byteLength);
  const metaPtr = mod._malloc(meta.byteLength);
  const entriesPtr = mod._malloc(Math.max(4, entries.byteLength));
  if (!outPtr || !pcmPtr || !metaPtr || !entriesPtr) {
    if (outPtr) mod._free(outPtr);
    if (pcmPtr) mod._free(pcmPtr);
    if (metaPtr) mod._free(metaPtr);
    if (entriesPtr) mod._free(entriesPtr);
    lastMixBackend = 'unavailable';
    return null;
  }

  try {
    mod.HEAPF32.set(blob, pcmPtr >> 2);
    mod.HEAP32.set(meta, metaPtr >> 2);
    if (entries.length) mod.HEAPF32.set(entries, entriesPtr >> 2);
    const rc = mod._mix_timeline_audio(
      outPtr,
      outFrames,
      sampleRate,
      channels,
      pcmPtr,
      metaPtr,
      clipIds.length,
      entriesPtr,
      schedule.length,
    );
    if (rc !== 0) {
      lastMixBackend = 'unavailable';
      return null;
    }
    const frames = new Float32Array(outFrames * channels);
    frames.set(mod.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + frames.length));
    lastMixBackend = 'wasm';
    return { sampleRate, channels, frames };
  } finally {
    mod._free(outPtr);
    mod._free(pcmPtr);
    mod._free(metaPtr);
    mod._free(entriesPtr);
  }
}

/** Interleave an AudioBuffer's channels into packed f32. */
export function audioBufferToInterleaved(buffer: AudioBuffer): ClipPcm {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const n = buffer.length;
  const frames = new Float32Array(n * channels);
  if (channels === 1) {
    frames.set(buffer.getChannelData(0));
  } else {
    const l = buffer.getChannelData(0);
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
    for (let i = 0; i < n; i++) {
      frames[i * 2] = l[i] ?? 0;
      frames[i * 2 + 1] = r[i] ?? 0;
    }
  }
  return { sampleRate: buffer.sampleRate, channels, frames };
}

export function writeMixToAudioBuffer(
  mix: MixTimelineResult,
  ctx: BaseAudioContext,
): AudioBuffer {
  const frames = mix.frames.length / mix.channels;
  const buffer = ctx.createBuffer(mix.channels, frames, mix.sampleRate);
  if (mix.channels === 1) {
    buffer.getChannelData(0).set(mix.frames);
    return buffer;
  }
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  for (let i = 0; i < frames; i++) {
    l[i] = mix.frames[i * 2] ?? 0;
    r[i] = mix.frames[i * 2 + 1] ?? 0;
  }
  return buffer;
}

/** True when the WASM mixer cannot represent a schedule (curves / pan). */
export function scheduleNeedsOfflineAudioMix(
  entries: Array<{
    volumeAutomation?: unknown[];
    panAutomation?: unknown[];
  }>,
): boolean {
  return entries.some(
    (e) => (e.volumeAutomation?.length ?? 0) > 0 || (e.panAutomation?.length ?? 0) > 0,
  );
}
