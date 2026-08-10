/**
 * Per-clip parameter automation — sample volume/pan(/playbackRate) keyframe
 * lanes over local clip time. Reuses the shared Keyframe infrastructure.
 */

import type { Clip, ClipAutomation, ClipAutomationProp } from '../types';
import type { Keyframe } from './keyframes';
import { sampleKeyframes, sortKeyframes } from './keyframes';
import {
  clampClipVolume,
  DEFAULT_CLIP_VOLUME,
  MAX_CLIP_VOLUME,
  MIN_CLIP_VOLUME,
} from './audioVolume';
import {
  clampClipPlaybackRate,
  DEFAULT_CLIP_PLAYBACK_RATE,
  getClipPlaybackRate,
  MAX_CLIP_PLAYBACK_RATE,
  MIN_CLIP_PLAYBACK_RATE,
} from './playbackRate';

export const MIN_CLIP_PAN = -1;
export const MAX_CLIP_PAN = 1;
export const DEFAULT_CLIP_PAN = 0;

export {
  DEFAULT_CLIP_PLAYBACK_RATE,
  MIN_CLIP_PLAYBACK_RATE,
  MAX_CLIP_PLAYBACK_RATE,
  clampClipPlaybackRate,
};

export function clampClipPan(pan: number | undefined): number {
  const value = pan ?? DEFAULT_CLIP_PAN;
  if (!Number.isFinite(value)) return DEFAULT_CLIP_PAN;
  return Math.min(MAX_CLIP_PAN, Math.max(MIN_CLIP_PAN, value));
}

export function defaultAutomationValue(
  clip: Pick<Clip, 'volume' | 'playbackRate'>,
  prop: ClipAutomationProp,
): number {
  switch (prop) {
    case 'volume':
      return clampClipVolume(clip.volume);
    case 'pan':
      return DEFAULT_CLIP_PAN;
    case 'playbackRate':
      return getClipPlaybackRate(clip);
  }
}

export function clampAutomationValue(
  prop: ClipAutomationProp,
  value: number,
): number {
  switch (prop) {
    case 'volume':
      return Math.min(MAX_CLIP_VOLUME, Math.max(MIN_CLIP_VOLUME, value));
    case 'pan':
      return clampClipPan(value);
    case 'playbackRate':
      return clampClipPlaybackRate(value);
  }
}

/**
 * Sample an automation lane at local clip time `localT` (seconds).
 * Empty / missing lanes return the scalar default for that property.
 */
export function sampleAutomation(
  clip: Pick<Clip, 'volume' | 'playbackRate' | 'automation'>,
  prop: ClipAutomationProp,
  localT: number,
): number {
  const track = clip.automation?.[prop];
  const fallback = defaultAutomationValue(clip, prop);
  return clampAutomationValue(prop, sampleKeyframes(track, localT, fallback));
}

/** True when the clip has at least one non-empty automation lane. */
export function clipHasAutomation(
  clip: Pick<Clip, 'automation'> | null | undefined,
): boolean {
  const automation = clip?.automation;
  if (!automation) return false;
  return (Object.keys(automation) as ClipAutomationProp[]).some(
    (prop) => (automation[prop]?.length ?? 0) > 0,
  );
}

/** Volume or pan lanes that need OfflineAudioContext premix (not FFmpeg filters). */
export function clipHasAudioAutomation(
  clip: Pick<Clip, 'automation'> | null | undefined,
): boolean {
  const automation = clip?.automation;
  if (!automation) return false;
  return (
    (automation.volume?.length ?? 0) > 0 || (automation.pan?.length ?? 0) > 0
  );
}

export function timelineHasAudioAutomation(
  clips: Array<Pick<Clip, 'automation'>>,
): boolean {
  return clips.some(clipHasAudioAutomation);
}

/** Sanitize / deep-copy automation for serialize / apply. */
export function normalizeClipAutomation(
  automation: ClipAutomation | undefined,
): ClipAutomation | undefined {
  if (!automation) return undefined;
  const next: ClipAutomation = {};
  for (const prop of ['volume', 'pan', 'playbackRate'] as ClipAutomationProp[]) {
    const track = automation[prop];
    if (!track?.length) continue;
    const cleaned = sortKeyframes(
      track
        .filter(
          (key) =>
            Number.isFinite(key.t) &&
            Number.isFinite(key.value) &&
            key.t >= 0,
        )
        .map(
          (key): Keyframe => ({
            t: key.t,
            value: clampAutomationValue(prop, key.value),
            ...(key.easing ? { easing: { ...key.easing } } : {}),
          }),
        ),
    );
    if (cleaned.length > 0) next[prop] = cleaned;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Build AudioParam breakpoints for a gain (or pan) curve over a play window.
 * Includes fade envelopes when `fadeIn` / `fadeOut` are set (gain only).
 */
export function collectAutomationBreakpoints(
  options: {
    duration: number;
    clipElapsed: number;
    playDuration: number;
    keyframes?: Keyframe[];
    defaultValue: number;
    fadeIn?: number;
    fadeOut?: number;
    /** Samples per second for bezier / dense segments. */
    sampleHz?: number;
  },
): Array<{ localTime: number; value: number }> {
  const {
    duration,
    clipElapsed,
    playDuration,
    keyframes,
    defaultValue,
    fadeIn = 0,
    fadeOut = 0,
    sampleHz = 40,
  } = options;

  const endLocal = clipElapsed + playDuration;
  const times = new Set<number>([clipElapsed, endLocal]);

  if (fadeIn > 0) {
    times.add(0);
    times.add(Math.min(fadeIn, endLocal));
  }
  if (fadeOut > 0) {
    times.add(Math.max(0, duration - fadeOut));
    times.add(duration);
  }

  const track = sortKeyframes(keyframes ?? []);
  for (const key of track) {
    if (key.t >= clipElapsed - 1e-6 && key.t <= endLocal + 1e-6) {
      times.add(Math.min(endLocal, Math.max(clipElapsed, key.t)));
    }
  }

  // Densify between consecutive keyframes when easing is non-linear.
  const step = 1 / Math.max(8, sampleHz);
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    const easing = a.easing;
    const needsDense =
      easing &&
      easing.type === 'bezier' &&
      b.t > a.t &&
      b.t >= clipElapsed &&
      a.t <= endLocal;
    if (!needsDense) continue;
    for (let t = a.t + step; t < b.t; t += step) {
      if (t >= clipElapsed && t <= endLocal) times.add(t);
    }
  }

  // Also densify across fade ramps when automation is present mid-fade.
  if ((fadeIn > 0 || fadeOut > 0) && track.length > 0) {
    for (let t = clipElapsed + step; t < endLocal; t += step) {
      const inFadeIn = fadeIn > 0 && t < fadeIn;
      const inFadeOut = fadeOut > 0 && t > duration - fadeOut;
      if (inFadeIn || inFadeOut) times.add(t);
    }
  }

  const sorted = [...times].sort((a, b) => a - b);
  return sorted.map((localTime) => {
    let value = sampleKeyframes(keyframes, localTime, defaultValue);
    if (fadeIn > 0 && localTime < fadeIn) {
      value *= localTime / fadeIn;
    }
    if (fadeOut > 0 && localTime > duration - fadeOut) {
      const outProgress = (duration - localTime) / fadeOut;
      value *= Math.max(0, Math.min(1, outProgress));
    }
    return { localTime, value };
  });
}

/**
 * Schedule linear AudioParam automation from clip-local breakpoints.
 * `when` is the AudioContext time corresponding to `clipElapsed`.
 */
export function scheduleAudioParamBreakpoints(
  param: AudioParam,
  breakpoints: Array<{ localTime: number; value: number }>,
  when: number,
  clipElapsed: number,
  earliestTime: number,
): void {
  if (breakpoints.length === 0) return;
  const startTime = Math.max(when, earliestTime);
  param.cancelScheduledValues(startTime);

  let first = true;
  for (const point of breakpoints) {
    const ctxTime = when + (point.localTime - clipElapsed);
    if (ctxTime < startTime - 1e-6) continue;
    const t = Math.max(startTime, ctxTime);
    if (first) {
      param.setValueAtTime(point.value, t);
      first = false;
    } else {
      param.linearRampToValueAtTime(point.value, t);
    }
  }

  // Ensure at least the starting level is set when all points were in the past.
  if (first) {
    const last = breakpoints[breakpoints.length - 1];
    param.setValueAtTime(last.value, startTime);
  }
}

/** Encode an AudioBuffer as a 16-bit stereo/mono WAV suitable for FFmpeg VFS. */
export function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  const out = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(out);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1)));
  }

  let offset = headerSize;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i] ?? 0));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return out;
}

export { DEFAULT_CLIP_VOLUME };
