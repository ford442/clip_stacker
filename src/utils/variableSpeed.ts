/**
 * FFmpeg variable-speed filter generation from playbackRate automation curves.
 * Micro-chunks the output timeline into constant-rate segments with setpts/atempo.
 */

import type { Clip } from '../types';
import {
  integrateRateToSourceOffset,
  remappedClipDuration,
} from './timeRemap';
import {
  audioTempoFilterSegment,
  formatPlaybackRate,
  getClipPlaybackRate,
  videoSetptsFilter,
} from './playbackRate';

export interface VariableSpeedSegment {
  /** Output-local start time (seconds). */
  outputStart: number;
  /** Output-local end time (seconds). */
  outputEnd: number;
  /** Source media start (absolute, includes trimStart). */
  sourceStart: number;
  /** Source media end (absolute). */
  sourceEnd: number;
  /** Average speed multiplier for this segment (source consumed / output duration). */
  rate: number;
}

export interface VariableSpeedFilterResult {
  /** Labeled video stream after time-warp (typically [vspeed]). */
  videoLabel: string;
  /** Labeled audio stream after time-warp (typically [aspeed]). */
  audioLabel: string;
  videoFilter: string;
  audioFilter: string;
  segmentCount: number;
}

const MIN_SEGMENT_SEC = 0.02;
const DEFAULT_SEGMENT_COUNT = 48;

/**
 * Build constant-rate segments covering the clip's output duration.
 * Segment boundaries include automation keyframe times for accuracy.
 */
export function buildVariableSpeedSegments(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation'>,
  segmentCount = DEFAULT_SEGMENT_COUNT,
): VariableSpeedSegment[] {
  const outputDuration = remappedClipDuration(clip);
  const trimStart = clip.trimStart;
  const defaultRate = getClipPlaybackRate(clip);
  const keyframes = clip.automation?.playbackRate ?? [];

  const boundaries = new Set<number>([0, outputDuration]);
  for (const key of keyframes) {
    if (key.t > 0 && key.t < outputDuration) boundaries.add(key.t);
  }

  const baseCount = Math.max(2, segmentCount);
  for (let i = 1; i < baseCount; i++) {
    boundaries.add((outputDuration * i) / baseCount);
  }

  const sorted = [...boundaries].sort((a, b) => a - b);
  const segments: VariableSpeedSegment[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const outputStart = sorted[i];
    const outputEnd = sorted[i + 1];
    const span = outputEnd - outputStart;
    if (span < MIN_SEGMENT_SEC) continue;

    const srcOffset0 = integrateRateToSourceOffset(
      keyframes.length ? keyframes : undefined,
      defaultRate,
      outputStart,
    );
    const srcOffset1 = integrateRateToSourceOffset(
      keyframes.length ? keyframes : undefined,
      defaultRate,
      outputEnd,
    );
    const sourceConsumed = Math.max(1e-9, srcOffset1 - srcOffset0);
    const rate = sourceConsumed / span;

    segments.push({
      outputStart,
      outputEnd,
      sourceStart: trimStart + srcOffset0,
      sourceEnd: trimStart + srcOffset1,
      rate,
    });
  }

  return segments;
}

/**
 * Translate a clip's speed automation curve into micro-chunked FFmpeg filters.
 * Returns labeled [vout] / [aout] filter chains for concat-style assembly.
 */
export function buildVariableSpeedFilter(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation'>,
  options: {
    segmentCount?: number;
    inputVideo?: string;
    inputAudio?: string;
    videoOutLabel?: string;
    audioOutLabel?: string;
  } = {},
): VariableSpeedFilterResult {
  const inputVideo = options.inputVideo ?? '[0:v]';
  const inputAudio = options.inputAudio ?? '[0:a]';
  const videoOut = options.videoOutLabel ?? 'vspeed';
  const audioOut = options.audioOutLabel ?? 'aspeed';
  const segments = buildVariableSpeedSegments(clip, options.segmentCount);
  const end = Number.isFinite(clip.trimEnd) ? (clip.trimEnd as number) : clip.duration;
  const trimStart = clip.trimStart;

  if (segments.length <= 1) {
    const rate = segments[0]?.rate ?? getClipPlaybackRate(clip);
    const srcStart = segments[0]?.sourceStart ?? trimStart;
    const srcEnd = segments[0]?.sourceEnd ?? end;
    const setpts = videoSetptsFilter(rate);
    const atempo = audioTempoFilterSegment(rate);
    return {
      videoLabel: `[${videoOut}]`,
      audioLabel: `[${audioOut}]`,
      videoFilter:
        `${inputVideo}trim=start=${formatPlaybackRate(srcStart)}:end=${formatPlaybackRate(srcEnd)},${setpts}[${videoOut}]`,
      audioFilter:
        `${inputAudio}atrim=start=${formatPlaybackRate(srcStart)}:end=${formatPlaybackRate(srcEnd)},asetpts=PTS-STARTPTS${atempo}[${audioOut}]`,
      segmentCount: 1,
    };
  }

  const videoParts: string[] = [];
  const audioParts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  segments.forEach((seg, i) => {
    const vLabel = `vseg${i}`;
    const aLabel = `aseg${i}`;
    const setpts = videoSetptsFilter(seg.rate);
    const atempo = audioTempoFilterSegment(seg.rate);
    videoParts.push(
      `${inputVideo}trim=start=${formatPlaybackRate(seg.sourceStart)}:end=${formatPlaybackRate(seg.sourceEnd)},${setpts}[${vLabel}]`,
    );
    audioParts.push(
      `${inputAudio}atrim=start=${formatPlaybackRate(seg.sourceStart)}:end=${formatPlaybackRate(seg.sourceEnd)},asetpts=PTS-STARTPTS${atempo}[${aLabel}]`,
    );
    videoLabels.push(`[${vLabel}]`);
    audioLabels.push(`[${aLabel}]`);
  });

  const n = segments.length;
  const videoFilter = `${videoParts.join(';')};${videoLabels.join('')}concat=n=${n}:v=1:a=0[${videoOut}]`;
  const audioFilter = `${audioParts.join(';')};${audioLabels.join('')}concat=n=${n}:v=0:a=1[${audioOut}]`;

  return {
    videoLabel: `[${videoOut}]`,
    audioLabel: `[${audioOut}]`,
    videoFilter,
    audioFilter,
    segmentCount: n,
  };
}
