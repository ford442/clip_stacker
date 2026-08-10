/**
 * WebCodecs audio encode + timeline mix for GPU export.
 *
 * Renders a mixed PCM buffer from the same schedule math as live playback
 * (`buildAudioSchedule`), encodes AAC-LC with `AudioEncoder`, and feeds chunks
 * to mp4-muxer alongside the hardware video track — keeping FFmpeg off the
 * happy path for soundtracked GPU exports.
 */

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

/** AAC-LC — matches the existing FFmpeg mux path (192 kbps stereo @ 48 kHz). */
export const AAC_CODEC = 'mp4a.40.2';
export const AAC_SAMPLE_RATE = 48_000;
export const AAC_CHANNELS = 2;
export const AAC_BITRATE = 192_000;
/** Typical AAC-LC frame size at 48 kHz. */
export const AAC_FRAME_SAMPLES = 1024;

/** OfflineAudioContext render cap — longer timelines fall back to FFmpeg mux. */
export const MAX_OFFLINE_AUDIO_SECONDS = 45 * 60;

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
 * Whether the timeline audio mix can be rendered offline for WebCodecs mux.
 * PiP overlays and dissolve overlaps are supported via `buildAudioSchedule`.
 */
export function assessWebCodecsAudioMix(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
): WebCodecsAudioMixSupport {
  if (typeof OfflineAudioContext === 'undefined') {
    return { supported: false, reason: 'OfflineAudioContext unavailable' };
  }

  const timelineClips = getTimelineClips(clips, groups);
  if (timelineClips.length === 0) {
    return { supported: false, reason: 'No timeline clips' };
  }

  const duration = computeTotalDuration(timelineClips, transitions);
  if (duration > MAX_OFFLINE_AUDIO_SECONDS) {
    return {
      supported: false,
      reason: `Timeline audio exceeds ${MAX_OFFLINE_AUDIO_SECONDS / 60} min offline mix limit`,
    };
  }

  const schedule = buildAudioSchedule(clips, groups, transitions);
  if (schedule.length === 0) {
    return { supported: false, reason: 'Empty audio schedule' };
  }

  return { supported: true };
}

/**
 * Render the mixed timeline audio into a single `AudioBuffer`.
 * Volume keyframes + per-clip fades + stereo pan match preview schedule math.
 */
export async function renderTimelineAudioMix(
  entries: AudioScheduleEntry[],
  durationSec: number,
  cache: ClipAudioCache = new ClipAudioCache(),
  fullSchedule: AudioScheduleEntry[] = entries,
): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('OfflineAudioContext unavailable');
  }

  const sampleCount = Math.max(1, Math.ceil(durationSec * AAC_SAMPLE_RATE));
  const offline = new OfflineAudioContext(AAC_CHANNELS, sampleCount, AAC_SAMPLE_RATE);

  for (const entry of entries) {
    const buffer = await cache.get(entry.clipId, entry.objectUrl, offline);
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
    source.start(start, entry.bufferOffset, entry.duration);
  }

  return offline.startRendering();
}

/**
 * Offline-mix the timeline and encode as WAV bytes for FFmpeg VFS mux.
 * Used when volume/pan automation is present (arbitrary curves aren't FFmpeg filters).
 */
export async function renderTimelineAudioMixWav(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
): Promise<Uint8Array | null> {
  const timelineClips = getTimelineClips(clips, groups);
  const durationSec = computeTotalDuration(timelineClips, transitions);
  const schedule = buildAudioSchedule(clips, groups, transitions);
  if (schedule.length === 0 || durationSec <= 0) return null;

  const mixed = await renderTimelineAudioMix(schedule, durationSec);
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

/**
 * Encode a mixed `AudioBuffer` to AAC-LC chunks via `AudioEncoder`.
 * Handles the final partial frame at EOF.
 */
export async function encodeAudioBufferToAac(
  buffer: AudioBuffer,
): Promise<EncodedAacResult> {
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
    sampleRate: buffer.sampleRate,
    numberOfChannels: Math.min(buffer.numberOfChannels, AAC_CHANNELS),
    bitrate: AAC_BITRATE,
  });

  const channels = Math.min(buffer.numberOfChannels, AAC_CHANNELS);
  let timestampUs = 0;

  for (let offset = 0; offset < buffer.length; offset += AAC_FRAME_SAMPLES) {
    const { data, frames } = extractPlanarFrame(buffer, offset, AAC_FRAME_SAMPLES);
    if (frames <= 0) break;

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: buffer.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: timestampUs,
      data: data as BufferSource,
    });

    encoder.encode(audioData);
    audioData.close();
    if (encodeError) throw encodeError;

    timestampUs += Math.round((frames / buffer.sampleRate) * 1_000_000);
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  encoder.close();

  return { chunks };
}

/** Push encoded AAC chunks into an mp4-muxer instance. */
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
 * has no audible schedule (video-only export).
 */
export async function encodeTimelineAudio(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
): Promise<EncodedAacResult | null> {
  const timelineClips = getTimelineClips(clips, groups);
  const durationSec = computeTotalDuration(timelineClips, transitions);
  const schedule = buildAudioSchedule(clips, groups, transitions);
  if (schedule.length === 0 || durationSec <= 0) return null;

  const mixed = await renderTimelineAudioMix(schedule, durationSec);
  return encodeAudioBufferToAac(mixed);
}
