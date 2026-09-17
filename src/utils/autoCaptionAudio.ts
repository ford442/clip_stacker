/**
 * Audio handed to an auto-caption provider.
 *
 * Transcription must hear exactly what the viewer will: trims, mute, volume
 * automation and speed remaps included. So the timeline scope reuses the very
 * mix the export premix uses (`renderTimelineAudioMix` over
 * `buildAudioSchedule`) rather than a raw source file, and the clip scope
 * renders that same mix restricted to one clip's schedule entries — which is
 * also where the cue time offset comes from.
 */

import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import { buildAudioSchedule } from '../audio/schedule';
import { computeTotalDuration } from './transitions';
import { getTimelineClips } from './timelineClips';
import { renderTimelineAudioMix } from './webcodecs-audio';

export type AutoCaptionScope = 'timeline' | 'clip';

export interface AutoCaptionAudio {
  audio: AudioBuffer;
  /** Seconds to add to every returned cue to land on the output timeline. */
  timeOffsetSec: number;
  /** Length of the rendered audio, for progress and status text. */
  durationSec: number;
}

export interface AutoCaptionAudioInput {
  clips: Clip[];
  groups: ClipGroup[];
  transitions: ClipTransition[];
  tracks?: Track[];
  scope: AutoCaptionScope;
  /** Required for the `'clip'` scope. */
  clipId?: string | null;
}

/**
 * Render the audio to transcribe. Throws with a user-facing message when
 * there is nothing audible in scope — the caller turns that into a status
 * line rather than a thrown render.
 */
export async function renderAutoCaptionAudio(
  input: AutoCaptionAudioInput,
): Promise<AutoCaptionAudio> {
  const { clips, groups, transitions, tracks = [], scope, clipId } = input;
  const schedule = buildAudioSchedule(clips, groups, transitions, tracks);
  if (schedule.length === 0) {
    throw new Error('Nothing on the timeline has audio to transcribe.');
  }

  if (scope === 'clip') {
    if (!clipId) throw new Error('Select a clip to transcribe it.');
    const entries = schedule.filter((entry) => entry.clipId === clipId);
    if (entries.length === 0) {
      throw new Error('The selected clip has no audio on the timeline (muted or trimmed out).');
    }
    const start = Math.min(...entries.map((entry) => entry.timelineStart));
    const end = Math.max(...entries.map((entry) => entry.timelineStart + entry.duration));
    const durationSec = Math.max(0, end - start);
    if (durationSec <= 0) throw new Error('The selected clip has no audible duration.');

    // Re-base the entries so the mix starts at t=0; `timeOffsetSec` puts the
    // cues back onto the output timeline. `fullSchedule` stays the whole
    // timeline so bed ducking matches what playback does.
    const shifted = entries.map((entry) => ({
      ...entry,
      timelineStart: entry.timelineStart - start,
    }));
    const audio = await renderTimelineAudioMix(shifted, durationSec, undefined, schedule);
    return { audio, timeOffsetSec: start, durationSec };
  }

  const durationSec = computeTotalDuration(getTimelineClips(clips, groups), transitions);
  if (durationSec <= 0) throw new Error('The timeline is empty.');
  const audio = await renderTimelineAudioMix(schedule, durationSec);
  return { audio, timeOffsetSec: 0, durationSec };
}

/**
 * Down-mix to the mono 16 kHz Float32 PCM every Whisper build expects.
 *
 * Linear interpolation is enough here: speech models are trained on 16 kHz
 * and the mix is already band-limited well below Nyquist.
 */
export function toWhisperPcm(buffer: AudioBuffer, targetRate = 16000): Float32Array {
  const channels = buffer.numberOfChannels;
  const inputLength = buffer.length;
  const mono = new Float32Array(inputLength);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < inputLength; i++) mono[i] += data[i] / channels;
  }

  if (Math.abs(buffer.sampleRate - targetRate) < 1) return mono;

  const ratio = buffer.sampleRate / targetRate;
  const outputLength = Math.max(1, Math.floor(inputLength / ratio));
  const out = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = mono[index] ?? 0;
    const b = mono[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
