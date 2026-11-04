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

import type { Clip, ClipGroup, ClipTransition } from '../types';
import { ClipAudioCache } from '../audio/clipAudioCache';
import {
  buildAudioSchedule,
  effectiveEntryVolume,
  type AudioScheduleEntry,
} from '../audio/schedule';
import { computeTotalDuration } from '../timeline/transitions';
import { getTimelineClips } from '../timeline/timelineClips';
import {
  applyGainEnvelope,
  applyPanEnvelope,
} from '../audio/gainEnvelope';
import {
  audioBufferToWav,
  timelineHasAudioAutomation,
} from '../timeline/clipAutomation';
import { RemappedAudioCache } from '../audio/remappedAudioCache';
import {
  clipAudioEffectsActive,
  masterLimiterActive,
  normalizeMasterLimiter,
  type MasterLimiterSettings,
} from '../audio/audioEffects';
import { exportStateSource } from './exportSources';
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
  scheduleNeedsOfflineAudioMix,
  type ClipPcmProvider,
  type MediaEngineMixEntry,
} from '../wasm/mediaEngine';
import { openMixStream, type MixStream } from '../audio/audioRenderClient';

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
  limiter?: MasterLimiterSettings | null | undefined;
  /**
   * Lanes (routing, lane FX, ducks) and the master bus / loudness target.
   * Null mixes every entry straight to the master sum with no bus
   * processing — what auto-caption audio wants (`autoCaptionAudio.ts`).
   */
  bus?: ExportAudioBus | null | undefined;
}

/** The export settings' master limiter, or null when it is off. */
export function exportMasterLimiter(): MasterLimiterSettings | null {
  const limiter = normalizeMasterLimiter(exportStateSource().masterLimiter());
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
    ...(entry.volumeAutomation !== undefined ? { volumeAutomation: entry.volumeAutomation } : {}),
    ...(entry.panAutomation !== undefined ? { panAutomation: entry.panAutomation } : {}),
    ...(entry.audioEffects ? { effects: entry.audioEffects } : {}),
    ...(plan && entry.trackId != null && plan.laneIndex.has(entry.trackId)
      ? { bus: plan.laneIndex.get(entry.trackId)! }
      : {}),
  }));
}

/**
 * Buffer factory for the rate-remap / reverse caches (`createBuffer` only).
 * Decoding itself goes through `decodeAudio` (`ClipAudioCache`), at 48 kHz
 * like the mix.
 */
function createBufferContext(): OfflineAudioContext {
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
): Promise<{ stream: MixStream; ctx: OfflineAudioContext } | null> {
  if (!(await prepareStreamingAudioMix())) return null;
  if (scheduleNeedsOfflineAudioMix(entries)) return null;
  const ctx = createBufferContext();
  // The mix runs in the audio render worker; decoding (the provider) stays here.
  const stream = await openMixStream(
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
export async function openExportMix(
  entries: AudioScheduleEntry[],
  durationSec: number,
  cache: ClipAudioCache,
  fullSchedule: AudioScheduleEntry[],
  evict: boolean,
  options: TimelineAudioMixOptions,
): Promise<{ stream: MixStream; ctx: OfflineAudioContext; report: () => void } | null> {
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
