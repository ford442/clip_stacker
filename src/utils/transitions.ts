/**
 * Transition utilities — calculations and FFmpeg filter generation for
 * xfade (video) and acrossfade (audio) transitions between timeline clips.
 */

import type { Clip, ClipTransition, TransitionType } from '../types';
import { getClipDuration } from './project';

// ---------------------------------------------------------------------------
// Transition defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TRANSITION_DURATION = 0.5; // seconds
export const MIN_TRANSITION_DURATION = 0.1;
export const MAX_TRANSITION_DURATION = 2.0;

/** Map our active transition types to FFmpeg xfade transition names. 'none' is filtered out before this map is consulted. */
const XFADE_MAP: Partial<Record<TransitionType, string>> = {
  dissolve: 'fade',
  motion: 'smoothleft',
};

// ---------------------------------------------------------------------------
// Timeline math
// ---------------------------------------------------------------------------

/** Effective duration of each clip in seconds, respecting trim. */
export function getEffectiveDurations(clips: Clip[]): number[] {
  return clips.map(getClipDuration);
}

/**
 * Returns the xfade `offset` value for each transition.
 *
 * The offset is the point in the *accumulated output* stream where the
 * transition begins — i.e. just before the current clip would end.
 *
 * For a chain: [A] --T1-- [B] --T2-- [C]
 *   offset(T1) = D_A - T1
 *   offset(T2) = D_A + D_B - T1 - T2    (the earlier overlap reduces stream position)
 */
export function computeTransitionOffsets(
  durations: number[],
  transitions: ClipTransition[],
): number[] {
  // Build a quick-lookup map: clipIndex → transition
  const transMap = new Map(transitions.map((t) => [t.afterClipIndex, t]));

  const offsets: number[] = [];
  let accumulated = 0;
  let overlapSoFar = 0;

  for (let i = 0; i < durations.length - 1; i++) {
    accumulated += durations[i];
    const t = transMap.get(i + 1);
    if (t && t.type !== 'none' && t.duration > 0) {
      offsets.push(accumulated - overlapSoFar - t.duration);
      overlapSoFar += t.duration;
    } else {
      offsets.push(-1); // sentinel: no transition here
    }
  }

  return offsets;
}

/**
 * Total output duration (in seconds) taking transitions into account.
 */
export function computeTotalDuration(
  clips: Clip[],
  transitions: ClipTransition[],
): number {
  const durations = getEffectiveDurations(clips);
  const totalOverlap = transitions
    .filter((t) => t.type !== 'none')
    .reduce((s, t) => s + t.duration, 0);
  return Math.max(0, durations.reduce((a, b) => a + b, 0) - totalOverlap);
}

// ---------------------------------------------------------------------------
// FFmpeg filter building
// ---------------------------------------------------------------------------

/**
 * Build the full `filter_complex` string for a multi-clip render WITH transitions.
 *
 * Each clip must already have its per-clip video/audio filter parts applied
 * before being connected into the xfade/acrossfade chain.
 *
 * Returns `null` if no transitions are active (caller should use the
 * simpler concat path instead).
 */
export function buildTransitionFilterComplex(
  clips: Clip[],
  transitions: ClipTransition[],
): string | null {
  const activeTransitions = transitions.filter((t) => t.type !== 'none' && t.duration > 0);
  if (activeTransitions.length === 0) return null;

  const durations = getEffectiveDurations(clips);
  const transMap = new Map(activeTransitions.map((t) => [t.afterClipIndex, t]));

  const parts: string[] = [];

  // Step 1 — per-clip trim + fade filters
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const dur = durations[i];
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const safeVOut = Math.max(0, dur - clip.videoFadeOut);
    const safeAOut = Math.max(0, dur - clip.audioFadeOut);

    if (clip.kind === 'video') {
      let vf = `[${i}:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
      if (clip.videoFadeIn > 0) vf += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
      if (clip.videoFadeOut > 0) vf += `,fade=t=out:st=${safeVOut}:d=${clip.videoFadeOut}`;
      parts.push(`${vf}[v${i}]`);

      let af = `[${i}:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
      if (clip.audioFadeIn > 0) af += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
      if (clip.audioFadeOut > 0) af += `,afade=t=out:st=${safeAOut}:d=${clip.audioFadeOut}`;
      parts.push(`${af}[a${i}]`);
    } else {
      // audio-only: black video
      parts.push(`color=c=black:s=1280x720:d=${dur}[v${i}]`);
      let af = `[${i}:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
      if (clip.audioFadeIn > 0) af += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
      if (clip.audioFadeOut > 0) af += `,afade=t=out:st=${safeAOut}:d=${clip.audioFadeOut}`;
      parts.push(`${af}[a${i}]`);
    }
  }

  // Step 2 — chain xfade / acrossfade transitions
  let accumulated = 0;
  let overlapSoFar = 0;
  let currentV = 'v0';
  let currentA = 'a0';

  for (let i = 1; i < clips.length; i++) {
    accumulated += durations[i - 1];
    const t = transMap.get(i);

    if (t && t.duration > 0) {
      const offset = Math.max(0, accumulated - overlapSoFar - t.duration);
      const xfadeType = XFADE_MAP[t.type] ?? 'fade';
      const outV = i < clips.length - 1 ? `vt${i}` : 'vout';
      const outA = i < clips.length - 1 ? `at${i}` : 'aout';

      parts.push(
        `[${currentV}][v${i}]xfade=transition=${xfadeType}:duration=${t.duration}:offset=${offset.toFixed(4)}[${outV}]`,
      );
      parts.push(
        `[${currentA}][a${i}]acrossfade=d=${t.duration}[${outA}]`,
      );

      currentV = outV;
      currentA = outA;
      overlapSoFar += t.duration;
    } else {
      // Hard cut — concatenate
      const outV = i < clips.length - 1 ? `vt${i}` : 'vout';
      const outA = i < clips.length - 1 ? `at${i}` : 'aout';
      parts.push(`[${currentV}][v${i}]concat=n=2:v=1:a=0[${outV}]`);
      parts.push(`[${currentA}][a${i}]concat=n=2:v=0:a=1[${outA}]`);
      currentV = outV;
      currentA = outA;
    }
  }

  return parts.join(';');
}

// ---------------------------------------------------------------------------
// Helpers for the UI
// ---------------------------------------------------------------------------

/** Create a default set of transitions for a new list of clips (dissolve, 0.5 s). */
export function createDefaultTransitions(clips: Clip[]): ClipTransition[] {
  return clips.slice(1).map((_, i) => ({
    afterClipIndex: i + 1,
    type: 'dissolve' as TransitionType,
    duration: DEFAULT_TRANSITION_DURATION,
  }));
}

/** Update transitions array when a clip is removed or inserted. */
export function reindexTransitions(
  transitions: ClipTransition[],
  removedIndex: number,
): ClipTransition[] {
  return transitions
    .filter((t) => t.afterClipIndex !== removedIndex)
    .map((t) => ({
      ...t,
      afterClipIndex: t.afterClipIndex > removedIndex ? t.afterClipIndex - 1 : t.afterClipIndex,
    }));
}
