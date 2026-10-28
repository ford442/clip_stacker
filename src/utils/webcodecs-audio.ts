/**
 * WebCodecs audio encode + timeline mix for GPU export.
 *
 * Mixes PCM from the same schedule math as live playback (`buildAudioSchedule`),
 * encodes AAC-LC with `AudioEncoder`, and feeds chunks to the MP4 writer alongside
 * the hardware video track — keeping FFmpeg off the happy path for
 * soundtracked GPU exports. With the media-engine WASM loaded the mix streams
 * chunk by chunk (no length cap); OfflineAudioContext is the fallback.
 *
 * Clip insert effects, lane buses (FX, sidechain ducks), the master bus, the
 * loudness target and the master limiter exist only in the media engine
 * (`exportAudioBus.ts`): the OfflineAudioContext fallback mixes dry rather
 * than inventing its own EQ.
 *
 * Audio lanes are part of the export mix: the schedule is built with the
 * project's tracks, as the preview builds it.
 */

import { waitForQueueBelow } from './codecQueue';
import type { Clip, ClipGroup, ClipTransition } from '../types';
import { ClipAudioCache } from '../audio/clipAudioCache';
import {
  buildAudioSchedule,
  effectiveEntryVolume,
  type AudioScheduleEntry,
} from '../audio/schedule';
import { computeTotalDuration } from './transitions';
import { getTimelineClips } from './timelineClips';
import {
  applyGainEnvelope,
  applyPanEnvelope,
} from '../audio/playbackManager';
import {
  audioBufferToWav,
  timelineHasAudioAutomation,
} from './clipAutomation';
import { RemappedAudioCache } from './remappedAudioCache';
import {
  clipAudioEffectsActive,
  masterLimiterActive,
  normalizeMasterLimiter,
  type MasterLimiterSettings,
} from './audioEffects';
import { settingsStore } from '../store/settingsStore';
import type { BusGraphPlan } from '../audio/fxGraph';
import {
  engineReport,
  exportAudioBus,
  exportBusActive,
  exportHasAudioLaneClips,
  finalExportPass,
  loudnessGainDb,
  measureStream,
  measuringExportPass,
  noteExportAudio,
  type ExportAudioBus,
  type ExportMixPass,
} from './exportAudioBus';
import {
  audioBufferToClipPcm,
  isMediaEngineMixEnabled,
  isMediaEngineReady,
  loadMediaEngineModule,
  openTimelineMixStream,
  scheduleNeedsOfflineAudioMix,
  type ClipPcmProvider,
  type MediaEngineMixEntry,
  type TimelineMixStream,
} from '../wasm/mediaEngine';

/** AAC-LC — matches the existing FFmpeg mux path (192 kbps stereo @ 48 kHz). */
export const AAC_CODEC = 'mp4a.40.2';
export const AAC_SAMPLE_RATE = 48_000;
export const AAC_CHANNELS = 2;
export const AAC_BITRATE = 192_000;
/** Typical AAC-LC frame size at 48 kHz. */
export const AAC_FRAME_SAMPLES = 1024;

/**
 * OfflineAudioContext render cap. Longer timelines need the streaming
 * media-engine mix; without it they fall back to FFmpeg mux.
 */
export const MAX_OFFLINE_AUDIO_SECONDS = 45 * 60;
/** Queued `AudioData` before the streaming encoder waits for the codec. */
const MAX_ENCODE_QUEUE = 64;

export type WebCodecsAudioMixSupport =
  | { supported: true }
  | { supported: false; reason: string };

/** Probe `AudioEncoder` for AAC-LC at export settings. */
export async function isAudioEncoderAvailable(): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: AAC_CODEC,
      sampleRate: AAC_SAMPLE_RATE,
      numberOfChannels: AAC_CHANNELS,
      bitrate: AAC_BITRATE,
    });
    return result.supported === true;
  } catch {
    return false;
  }
}

/**
 * Load the media engine (unless `?no_media_engine`) so export can stream the
 * mix. False when disabled or the WASM failed to load.
 */
export async function prepareStreamingAudioMix(): Promise<boolean> {
  if (!isMediaEngineMixEnabled()) return false;
  await loadMediaEngineModule();
  return isMediaEngineReady();
}

/**
 * Whether the timeline audio mix can be rendered offline for WebCodecs mux.
 * PiP overlays and dissolve overlaps are supported via `buildAudioSchedule`.
 * `streamingMix` (from `prepareStreamingAudioMix`) lifts the OfflineAudioContext
 * length cap.
 */
export function assessWebCodecsAudioMix(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  options: { streamingMix?: boolean; bus?: ExportAudioBus | null } = {},
): WebCodecsAudioMixSupport {
  if (typeof OfflineAudioContext === 'undefined') {
    return { supported: false, reason: 'OfflineAudioContext unavailable' };
  }

  const timelineClips = getTimelineClips(clips, groups);
  if (timelineClips.length === 0) {
    return { supported: false, reason: 'No timeline clips' };
  }

  const duration = computeTotalDuration(timelineClips, transitions);
  if (duration > MAX_OFFLINE_AUDIO_SECONDS && !options.streamingMix) {
    return {
      supported: false,
      reason: `Timeline audio exceeds ${MAX_OFFLINE_AUDIO_SECONDS / 60} min offline mix limit`,
    };
  }

  const bus = options.bus === undefined ? exportAudioBus() : options.bus;
  const schedule = buildAudioSchedule(clips, groups, transitions, bus?.tracks ?? []);
  if (schedule.length === 0) {
    return { supported: false, reason: 'Empty audio schedule' };
  }

  return { supported: true };
}

/** Mix-bus options for the export premix. */
export interface TimelineAudioMixOptions {
  /** Look-ahead limiter on the mix output (media engine only). */
  limiter?: MasterLimiterSettings | null;
  /**
   * Lanes (routing, lane FX, ducks) and the master bus / loudness target.
   * Null mixes every entry straight to the master sum with no bus
   * processing — what auto-caption audio wants (`autoCaptionAudio.ts`).
   */
  bus?: ExportAudioBus | null;
}

/** The export settings' master limiter, or null when it is off. */
export function exportMasterLimiter(): MasterLimiterSettings | null {
  const limiter = normalizeMasterLimiter(settingsStore.getState().exportSettings.masterLimiter);
  return masterLimiterActive(limiter) ? limiter : null;
}

/**
 * Whether the FFmpeg paths must replace filter-graph audio with a browser
 * premix: automation curves, insert effects and the bus limiter are not
 * FFmpeg filters.
 */
export function timelineNeedsAudioPremix(
  clips: Array<Pick<Clip, 'automation' | 'audioEffects'>>,
  limiter: MasterLimiterSettings | null = exportMasterLimiter(),
  bus: ExportAudioBus | null = exportAudioBus(),
): boolean {
  return (
    timelineHasAudioAutomation(clips) ||
    clips.some((clip) => clipAudioEffectsActive(clip.audioEffects)) ||
    masterLimiterActive(limiter) ||
    exportBusActive(bus) ||
    exportHasAudioLaneClips(bus)
  );
}

function entryPlaybackRate(entry: AudioScheduleEntry): number {
  if (entry.rateRemap) return 1;
  if (Number.isFinite(entry.playbackRate) && entry.playbackRate > 0) {
    return entry.playbackRate;
  }
  return 1;
}

function toMixEntries(
  entries: AudioScheduleEntry[],
  fullSchedule: AudioScheduleEntry[],
  plan: BusGraphPlan | null = null,
): MediaEngineMixEntry[] {
  return entries.map((entry) => ({
    clipId: entry.clipId,
    timelineStart: entry.timelineStart,
    duration: entry.duration,
    bufferOffset: entry.bufferOffset,
    volume: effectiveEntryVolume(entry, fullSchedule),
    audioFadeIn: entry.audioFadeIn,
    audioFadeOut: entry.audioFadeOut,
    playbackRate: entryPlaybackRate(entry),
    volumeAutomation: entry.volumeAutomation,
    panAutomation: entry.panAutomation,
    ...(entry.audioEffects ? { effects: entry.audioEffects } : {}),
    ...(plan && entry.trackId != null && plan.laneIndex.has(entry.trackId)
      ? { bus: plan.laneIndex.get(entry.trackId)! }
      : {}),
  }));
}

/** Decode-only context: `decodeAudioData` resamples to 48 kHz like the mix. */
function createDecodeContext(): OfflineAudioContext {
  return new OfflineAudioContext(AAC_CHANNELS, 1, AAC_SAMPLE_RATE);
}

/**
 * Decode (and rate-remap) schedule entries on demand for the streaming mixer.
 * With `evict`, a clip's decoded buffer is dropped once every entry that uses
 * it has been mixed, so a long show only holds the clips under the playhead.
 */
function createSchedulePcmProvider(
  entries: AudioScheduleEntry[],
  cache: ClipAudioCache,
  ctx: BaseAudioContext,
  evict: boolean,
): ClipPcmProvider {
  const remapCache = new RemappedAudioCache();
  const usesLeft = new Map<string, number>();
  for (const entry of entries) {
    usesLeft.set(entry.clipId, (usesLeft.get(entry.clipId) ?? 0) + 1);
  }
  return {
    async acquire(index) {
      const entry = entries[index]!;
      const buffer = await remapCache.get(entry, cache, ctx);
      if (!buffer) {
        throw new Error(`Could not decode audio for clip "${entry.clipId}"`);
      }
      return audioBufferToClipPcm(buffer);
    },
    release(index) {
      if (!evict) return;
      const clipId = entries[index]!.clipId;
      const left = (usesLeft.get(clipId) ?? 1) - 1;
      usesLeft.set(clipId, left);
      if (left > 0) return;
      remapCache.delete(clipId);
      cache.delete(clipId);
    },
  };
}

async function openScheduleMixStream(
  entries: AudioScheduleEntry[],
  durationSec: number,
  cache: ClipAudioCache,
  fullSchedule: AudioScheduleEntry[],
  evict: boolean,
  pass: ExportMixPass,
): Promise<{ stream: TimelineMixStream; ctx: OfflineAudioContext } | null> {
  if (!(await prepareStreamingAudioMix())) return null;
  if (scheduleNeedsOfflineAudioMix(entries)) return null;
  const ctx = createDecodeContext();
  const stream = await openTimelineMixStream(
    toMixEntries(entries, fullSchedule, pass.bus),
    createSchedulePcmProvider(entries, cache, ctx, evict),
    {
      sampleRate: AAC_SAMPLE_RATE,
      channels: AAC_CHANNELS,
      durationSec,
      limiter: pass.limiter,
      bus: pass.bus,
      meter: pass.meter,
    },
  );
  return stream ? { stream, ctx } : null;
}

/**
 * Open the export mix: one stream, or — with a loudness target — a metering
 * pass run to the end first, then the normalized stream. `report()` records
 * what ran once the caller has consumed the stream. Null when the media
 * engine cannot run it (callers fall back to OfflineAudioContext).
 */
async function openExportMix(
  entries: AudioScheduleEntry[],
  durationSec: number,
  cache: ClipAudioCache,
  fullSchedule: AudioScheduleEntry[],
  evict: boolean,
  options: TimelineAudioMixOptions,
): Promise<{ stream: TimelineMixStream; ctx: OfflineAudioContext; report: () => void } | null> {
  const bus = options.bus ?? null;
  const limiter = options.limiter ?? null;
  const target = exportBusActive(bus) ? bus.masterBus?.loudness : undefined;
  let measured = -Infinity;
  let gainDb = 0;
  if (target) {
    const metering = await openScheduleMixStream(
      entries, durationSec, cache, fullSchedule, evict, measuringExportPass(bus!),
    );
    if (!metering) return null;
    measured = await measureStream(metering.stream);
    gainDb = loudnessGainDb(target, measured);
  }
  const opened = await openScheduleMixStream(
    entries, durationSec, cache, fullSchedule, evict, finalExportPass(bus, limiter, gainDb),
  );
  if (!opened) return null;
  return {
    ...opened,
    report: () => noteExportAudio(engineReport(bus, measured, gainDb, opened.stream.readMeters())),
  };
}

/**
 * C++ mix (polyphase resample, inserts, volume/pan curves, fades, limiter)
 * written chunk by chunk into one AudioBuffer. Null → caller uses
 * OfflineAudioContext.
 */
async function tryWasmTimelineMix(
  entries: AudioScheduleEntry[],
  durationSec: number,
  cache: ClipAudioCache,
  fullSchedule: AudioScheduleEntry[],
  options: TimelineAudioMixOptions,
): Promise<AudioBuffer | null> {
  const opened = await openExportMix(entries, durationSec, cache, fullSchedule, false, options);
  if (!opened) return null;
  const { stream, ctx } = opened;
  try {
    const out = ctx.createBuffer(stream.channels, stream.totalFrames, stream.sampleRate);
    const left = out.getChannelData(0);
    const right = out.getChannelData(stream.channels > 1 ? 1 : 0);
    for await (const chunk of stream) {
      const { frames, frameCount, startFrame } = chunk;
      if (stream.channels === 1) {
        left.set(frames, startFrame);
        continue;
      }
      for (let i = 0; i < frameCount; i++) {
        left[startFrame + i] = frames[i * 2]!;
        right[startFrame + i] = frames[i * 2 + 1]!;
      }
    }
    opened.report();
    return out;
  } catch (err) {
    console.warn('[webcodecs-audio] media-engine mix failed; using OfflineAudioContext:', err);
    return null;
  } finally {
    stream.close();
  }
}

/**
 * Render the mixed timeline audio into a single `AudioBuffer`.
 * Volume keyframes + per-clip fades + stereo pan match preview schedule math.
 * Prefers media-engine WASM when loaded; OfflineAudioContext remains the fallback.
 */
export async function renderTimelineAudioMix(
  entries: AudioScheduleEntry[],
  durationSec: number,
  cache: ClipAudioCache = new ClipAudioCache(),
  fullSchedule: AudioScheduleEntry[] = entries,
  options: TimelineAudioMixOptions = {},
): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('OfflineAudioContext unavailable');
  }

  const wasmMix = await tryWasmTimelineMix(entries, durationSec, cache, fullSchedule, options);
  if (wasmMix) return wasmMix;
  // Dry: no inserts, buses, ducks or loudness without the media engine.
  noteExportAudio(exportBusActive(options.bus) ? { audioFx: 'offline-fallback' } : {});

  const sampleCount = Math.max(1, Math.ceil(durationSec * AAC_SAMPLE_RATE));
  const offline = new OfflineAudioContext(AAC_CHANNELS, sampleCount, AAC_SAMPLE_RATE);
  const remapCache = new RemappedAudioCache();

  for (const entry of entries) {
    const buffer = await remapCache.get(entry, cache, offline);
    if (!buffer) {
      throw new Error(`Could not decode audio for clip "${entry.clipId}"`);
    }

    const source = offline.createBufferSource();
    source.buffer = buffer;

    const gain = offline.createGain();
    const start = entry.timelineStart;
    const duckedVolume = effectiveEntryVolume(entry, fullSchedule);
    applyGainEnvelope(
      gain.gain,
      { ...entry, volume: duckedVolume },
      start,
      entry.duration,
      0,
      0,
    );

    let leaf: AudioNode = gain;
    if (typeof offline.createStereoPanner === 'function') {
      const panner = offline.createStereoPanner();
      applyPanEnvelope(
        panner.pan,
        entry.panAutomation,
        start,
        entry.duration,
        0,
        0,
        entry.duration,
      );
      source.connect(gain);
      gain.connect(panner);
      leaf = panner;
    } else {
      source.connect(gain);
    }
    leaf.connect(offline.destination);

    const rate = entryPlaybackRate(entry);
    source.playbackRate.value = rate;
    source.start(start, entry.bufferOffset, entry.duration * rate);
  }

  return offline.startRendering();
}

/**
 * Offline-mix the timeline and encode as WAV bytes for FFmpeg VFS mux.
 * Used when `timelineNeedsAudioPremix` (automation curves, inserts, buses,
 * audio lanes, limiter). The limiter and buses default to the export
 * settings' and the editor's.
 */
export async function renderTimelineAudioMixWav(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  options: TimelineAudioMixOptions = { limiter: exportMasterLimiter(), bus: exportAudioBus() },
): Promise<Uint8Array | null> {
  const timelineClips = getTimelineClips(clips, groups);
  const durationSec = computeTotalDuration(timelineClips, transitions);
  const schedule = buildAudioSchedule(clips, groups, transitions, options.bus?.tracks ?? []);
  if (schedule.length === 0 || durationSec <= 0) return null;

  const mixed = await renderTimelineAudioMix(schedule, durationSec, undefined, schedule, options);
  return new Uint8Array(audioBufferToWav(mixed));
}

export { timelineHasAudioAutomation };

/** Extract planar f32 channel data for one AAC frame from an `AudioBuffer`. */
export function extractPlanarFrame(
  buffer: AudioBuffer,
  offset: number,
  frameLength: number,
): { data: Float32Array; channels: number; frames: number } {
  const frames = Math.min(frameLength, buffer.length - offset);
  const channels = Math.min(buffer.numberOfChannels, AAC_CHANNELS);
  const data = new Float32Array(frames * channels);

  for (let ch = 0; ch < channels; ch++) {
    const channel = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
    for (let i = 0; i < frames; i++) {
      data[ch * frames + i] = channel[offset + i] ?? 0;
    }
  }

  return { data, channels, frames };
}

export interface EncodedAacResult {
  chunks: EncodedAudioChunk[];
}

/** Presentation time of absolute frame `frame` (µs), rounded per frame so it never drifts. */
function frameTimestampUs(frame: number, sampleRate: number): number {
  return Math.round((frame * 1_000_000) / sampleRate);
}

/** `AudioEncoder` configured for AAC-LC, fed planar frames at absolute positions. */
function openAacEncoder(sampleRate: number, channels: number) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    throw new Error('AudioEncoder unavailable');
  }

  const chunks: EncodedAudioChunk[] = [];
  let encodeError: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk) => chunks.push(chunk),
    error: (e) => { encodeError = e; },
  });
  encoder.configure({
    codec: AAC_CODEC,
    sampleRate,
    numberOfChannels: channels,
    bitrate: AAC_BITRATE,
  });

  const check = () => {
    if (encodeError) throw encodeError;
  };

  return {
    /** Encode `frames` planar frames (channel-major) starting at timeline frame `startFrame`. */
    encode(data: Float32Array, frames: number, startFrame: number): void {
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: frameTimestampUs(startFrame, sampleRate),
        data: data as BufferSource,
      });
      try {
        encoder.encode(audioData);
      } finally {
        audioData.close();
      }
      check();
    },
    /** Wait while the codec is behind, so streamed PCM does not pile up in its queue. */
    async drain(): Promise<void> {
      check();
      try {
        await waitForQueueBelow(encoder, MAX_ENCODE_QUEUE + 1);
      } catch (err) {
        check(); // prefer the codec's own error over "closed while waiting"
        throw err;
      }
    },
    async finish(): Promise<EncodedAacResult> {
      await encoder.flush();
      check();
      encoder.close();
      return { chunks };
    },
    abort(): void {
      if (encoder.state !== 'closed') encoder.close();
    },
  };
}

/**
 * Encode a mixed `AudioBuffer` to AAC-LC chunks via `AudioEncoder`.
 * Handles the final partial frame at EOF.
 */
export async function encodeAudioBufferToAac(
  buffer: AudioBuffer,
): Promise<EncodedAacResult> {
  const channels = Math.min(buffer.numberOfChannels, AAC_CHANNELS);
  const aac = openAacEncoder(buffer.sampleRate, channels);

  for (let offset = 0; offset < buffer.length; offset += AAC_FRAME_SAMPLES) {
    const { data, frames } = extractPlanarFrame(buffer, offset, AAC_FRAME_SAMPLES);
    if (frames <= 0) break;
    aac.encode(data, frames, offset);
  }

  return aac.finish();
}

/**
 * Stream the schedule through the media-engine mixer straight into AAC —
 * one chunk of PCM alive at a time, so there is no timeline length cap.
 * Null when the media engine is disabled or unavailable; throws if a clip
 * fails to decode or the encoder errors mid-stream.
 */
export async function encodeScheduleAudioStreaming(
  entries: AudioScheduleEntry[],
  durationSec: number,
  options: {
    cache?: ClipAudioCache;
    fullSchedule?: AudioScheduleEntry[];
    limiter?: MasterLimiterSettings | null;
    bus?: ExportAudioBus | null;
  } = {},
): Promise<EncodedAacResult | null> {
  if (typeof OfflineAudioContext === 'undefined') return null;
  const opened = await openExportMix(
    entries,
    durationSec,
    options.cache ?? new ClipAudioCache(),
    options.fullSchedule ?? entries,
    // Only evict decoded clips from a cache this export owns.
    !options.cache,
    { limiter: options.limiter, bus: options.bus },
  );
  if (!opened) return null;
  const { stream } = opened;

  let aac: ReturnType<typeof openAacEncoder> | null = null;
  try {
    aac = openAacEncoder(stream.sampleRate, stream.channels);
    const channels = stream.channels;
    const planar = new Float32Array(AAC_FRAME_SAMPLES * channels);
    for await (const chunk of stream) {
      for (let offset = 0; offset < chunk.frameCount; offset += AAC_FRAME_SAMPLES) {
        const frames = Math.min(AAC_FRAME_SAMPLES, chunk.frameCount - offset);
        for (let ch = 0; ch < channels; ch++) {
          const plane = ch * frames;
          for (let i = 0; i < frames; i++) {
            planar[plane + i] = chunk.frames[(offset + i) * channels + ch]!;
          }
        }
        aac.encode(planar.subarray(0, frames * channels), frames, chunk.startFrame + offset);
      }
      await aac.drain();
    }
    opened.report();
    return await aac.finish();
  } catch (err) {
    aac?.abort();
    throw err;
  } finally {
    stream.close();
  }
}

/**
 * Push encoded AAC chunks into an `Mp4Writer`. No metadata: the writer builds
 * the AAC-LC config from its declared audio track.
 */
export function addAacChunksToMuxer(
  muxer: { addAudioChunk: (chunk: EncodedAudioChunk) => void },
  chunks: EncodedAudioChunk[],
): void {
  for (const chunk of chunks) {
    muxer.addAudioChunk(chunk);
  }
}

/**
 * Render + encode timeline audio for export. Returns null when the timeline
 * has no audible schedule (video-only export). The limiter and buses default
 * to the export settings' and the editor's.
 */
export async function encodeTimelineAudio(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  options: TimelineAudioMixOptions = { limiter: exportMasterLimiter(), bus: exportAudioBus() },
): Promise<EncodedAacResult | null> {
  const timelineClips = getTimelineClips(clips, groups);
  const durationSec = computeTotalDuration(timelineClips, transitions);
  const schedule = buildAudioSchedule(clips, groups, transitions, options.bus?.tracks ?? []);
  if (schedule.length === 0 || durationSec <= 0) return null;

  const tooLongForOffline = durationSec > MAX_OFFLINE_AUDIO_SECONDS;
  try {
    const streamed = await encodeScheduleAudioStreaming(schedule, durationSec, {
      limiter: options.limiter,
      bus: options.bus,
    });
    if (streamed) return streamed;
  } catch (err) {
    if (tooLongForOffline) throw err;
    console.warn('[webcodecs-audio] streaming mix failed; retrying on OfflineAudioContext:', err);
  }
  if (tooLongForOffline) {
    throw new Error(
      `Timeline audio exceeds the ${MAX_OFFLINE_AUDIO_SECONDS / 60} min OfflineAudioContext limit and the media engine is unavailable`,
    );
  }

  const mixed = await renderTimelineAudioMix(schedule, durationSec, undefined, schedule, options);
  return encodeAudioBufferToAac(mixed);
}
