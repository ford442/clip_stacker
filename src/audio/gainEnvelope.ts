/**
 * Web Audio gain / pan envelopes for one scheduled source: volume keyframes
 * × audio fades, and stereo pan automation. Shared by preview playback
 * (`playbackManager.ts`) and the OfflineAudioContext export premix.
 *
 * C++ twin: `fade_gain` / `Curve` / `Panner` in `mix_timeline_audio_range`
 * (`native/media_engine/src/audio_mix.cpp`) — change both sides together.
 */

import type { AudioScheduleEntry } from './schedule';
import {
  collectAutomationBreakpoints,
  DEFAULT_CLIP_PAN,
  scheduleAudioParamBreakpoints,
} from '../utils/clipAutomation';
import { sampleKeyframes } from '../utils/keyframes';
import { clampClipVolume } from '../utils/audioVolume';

/**
 * Apply volume keyframes + per-clip audio fade envelopes relative to the
 * scheduled start of this source (`when`), accounting for mid-clip seeks via
 * `clipElapsed`. Automation values are absolute linear gain; fades multiply.
 */
export function applyGainEnvelope(
  param: AudioParam,
  entry: Pick<
    AudioScheduleEntry,
    'volume' | 'audioFadeIn' | 'audioFadeOut' | 'duration' | 'volumeAutomation'
  >,
  when: number,
  playDuration: number,
  clipElapsed: number,
  earliestTime: number,
): void {
  const volume = clampClipVolume(entry.volume);
  const hasAutomation = (entry.volumeAutomation?.length ?? 0) > 0;
  const fadeIn = entry.audioFadeIn;
  const fadeOut = entry.audioFadeOut;

  // Fast path: constant volume with optional linear fades (legacy behavior).
  if (!hasAutomation) {
    const startTime = Math.max(when, earliestTime);
    param.cancelScheduledValues(startTime);

    const levelAt = (localTime: number): number => {
      let level = volume;
      if (fadeIn > 0 && localTime < fadeIn) {
        level *= localTime / fadeIn;
      }
      if (fadeOut > 0 && localTime > entry.duration - fadeOut) {
        const outProgress = (entry.duration - localTime) / fadeOut;
        level *= Math.max(0, Math.min(1, outProgress));
      }
      return level;
    };

    param.setValueAtTime(levelAt(clipElapsed), startTime);

    if (fadeIn > 0 && clipElapsed < fadeIn) {
      const fadeInEnd = when + (fadeIn - clipElapsed);
      if (fadeInEnd > startTime) {
        param.linearRampToValueAtTime(volume, fadeInEnd);
      }
    }

    if (fadeOut > 0) {
      const fadeOutStartLocal = entry.duration - fadeOut;
      const fadeOutStart = when + (fadeOutStartLocal - clipElapsed);
      const fadeOutEnd = when + playDuration;
      if (fadeOutEnd > startTime && clipElapsed < entry.duration) {
        if (fadeOutStart > startTime) {
          param.setValueAtTime(volume, Math.max(startTime, fadeOutStart));
        }
        const endLevel = levelAt(clipElapsed + playDuration);
        param.linearRampToValueAtTime(endLevel, Math.max(startTime, fadeOutEnd));
      }
    }
    return;
  }

  const breakpoints = collectAutomationBreakpoints({
    duration: entry.duration,
    clipElapsed,
    playDuration,
    keyframes: entry.volumeAutomation,
    defaultValue: volume,
    fadeIn,
    fadeOut,
  }).map((point) => ({
    ...point,
    value: clampClipVolume(point.value),
  }));

  scheduleAudioParamBreakpoints(
    param,
    breakpoints,
    when,
    clipElapsed,
    earliestTime,
  );
}

/**
 * Apply stereo pan automation (−1…+1). Empty keyframes leave the pan centered.
 */
export function applyPanEnvelope(
  param: AudioParam,
  panAutomation: AudioScheduleEntry['panAutomation'],
  when: number,
  playDuration: number,
  clipElapsed: number,
  earliestTime: number,
  fullDuration?: number,
): void {
  const hasAutomation = (panAutomation?.length ?? 0) > 0;
  if (!hasAutomation) {
    const startTime = Math.max(when, earliestTime);
    param.cancelScheduledValues(startTime);
    param.setValueAtTime(DEFAULT_CLIP_PAN, startTime);
    return;
  }

  const duration = Math.max(
    fullDuration ?? 0,
    clipElapsed + playDuration,
  );
  const breakpoints = collectAutomationBreakpoints({
    duration,
    clipElapsed,
    playDuration,
    keyframes: panAutomation,
    defaultValue: DEFAULT_CLIP_PAN,
  }).map((point) => ({
    ...point,
    value: Math.max(-1, Math.min(1, point.value)),
  }));

  scheduleAudioParamBreakpoints(
    param,
    breakpoints,
    when,
    clipElapsed,
    earliestTime,
  );
}

/** Instantaneous pan at local clip time (for tests / meters). */
export function samplePanAt(
  panAutomation: AudioScheduleEntry['panAutomation'],
  localTime: number,
): number {
  return Math.max(
    -1,
    Math.min(1, sampleKeyframes(panAutomation, localTime, DEFAULT_CLIP_PAN)),
  );
}
