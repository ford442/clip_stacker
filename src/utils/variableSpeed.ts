/**
 * FFmpeg variable-speed filter generation from playbackRate automation curves.
 * Micro-chunks the output timeline into constant-rate segments with setpts/atempo.
 */

import type { Clip } from '../types';
import {
  cycleDurationForClip,
  integrateRateToSourceOffset,
} from './timeRemap';
import {
  audioTempoFilterSegment,
  getClipPlaybackRate,
  videoSetptsFilter,
} from './playbackRate';
import { audioReversePrefix, clipIsReversed, trimmedSourceEnd, videoReversePrefix } from './reverseClip';

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

/** Trim bounds are seconds, not playback rates — do not clamp them to 0.25–4. */
function formatTrimSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const fixed = value.toFixed(6);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * Build constant-rate segments covering the clip's output duration.
 * Segment boundaries include automation keyframe times for accuracy.
 */
export function buildVariableSpeedSegments(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation' | 'reversed'>,
  segmentCount = DEFAULT_SEGMENT_COUNT,
): VariableSpeedSegment[] {
  // One cycle only — looping repeats this segment set, it does not stretch it.
  const outputDuration = cycleDurationForClip(clip);
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
    // A reversed clip plays each consumed slice backward, so the trim of
    // this chunk is the mirror image inside the window (low → high) and
    // the filter graph appends `reverse` / `areverse`.
    const trimEnd = trimmedSourceEnd(clip);
    const sourceStart = clipIsReversed(clip)
      ? trimEnd - srcOffset1
      : trimStart + srcOffset0;
    const sourceEnd = clipIsReversed(clip)
      ? trimEnd - srcOffset0
      : trimStart + srcOffset1;

    segments.push({
      outputStart,
      outputEnd,
      sourceStart,
      sourceEnd,
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
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation' | 'reversed'>,
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
    const revV = videoReversePrefix(clip);
    const revA = audioReversePrefix(clip);
    return {
      videoLabel: `[${videoOut}]`,
      audioLabel: `[${audioOut}]`,
      videoFilter:
        `${inputVideo}trim=start=${formatTrimSeconds(srcStart)}:end=${formatTrimSeconds(srcEnd)},${revV}${setpts}[${videoOut}]`,
      audioFilter:
        `${inputAudio}atrim=start=${formatTrimSeconds(srcStart)}:end=${formatTrimSeconds(srcEnd)},${revA}asetpts=PTS-STARTPTS${atempo}[${audioOut}]`,
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
    const revV = videoReversePrefix(clip);
    const revA = audioReversePrefix(clip);
    videoParts.push(
      `${inputVideo}trim=start=${formatTrimSeconds(seg.sourceStart)}:end=${formatTrimSeconds(seg.sourceEnd)},${revV}${setpts}[${vLabel}]`,
    );
    audioParts.push(
      `${inputAudio}atrim=start=${formatTrimSeconds(seg.sourceStart)}:end=${formatTrimSeconds(seg.sourceEnd)},${revA}asetpts=PTS-STARTPTS${atempo}[${aLabel}]`,
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
