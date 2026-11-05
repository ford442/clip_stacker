/**
 * AAC encoding for export: WebCodecs `AudioEncoder` over a decoded buffer or
 * streamed straight from the timeline premix (`encodeScheduleAudioStreaming`,
 * no length cap), and the muxer hand-off. The mix itself is in
 * `webcodecsAudio.ts`.
 */

import { waitForQueueBelow } from './codecQueue';
import type { Clip, ClipGroup, ClipTransition } from '../types';
import { ClipAudioCache } from '../audio/clipAudioCache';
import {
  buildAudioSchedule,
  type AudioScheduleEntry,
} from '../audio/schedule';
import { computeTotalDuration } from '../timeline/transitions';
import { getTimelineClips } from '../timeline/timelineClips';




import {
  type MasterLimiterSettings,
} from '../audio/audioEffects';
import {
  exportAudioBus,
  type ExportAudioBus,
} from './exportAudioBus';


import {
  AAC_BITRATE,
  AAC_CHANNELS,
  AAC_CODEC,
  AAC_FRAME_SAMPLES,
  MAX_OFFLINE_AUDIO_SECONDS,
  exportMasterLimiter,
  openExportMix,
  renderTimelineAudioMix,
  type TimelineAudioMixOptions,
} from './webcodecsAudio';

const MAX_ENCODE_QUEUE = 64;

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
    limiter?: MasterLimiterSettings | null | undefined;
    bus?: ExportAudioBus | null | undefined;
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
