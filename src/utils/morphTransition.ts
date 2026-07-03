/**
 * RIFE morph-cut transition — frame-pair extraction, remote generation, and
 * timeline helpers. Duration math stays in transitions.ts (overlap window).
 */

import type { Clip, ClipTransition, MorphTransitionSegment } from '../types';
import { getClipDuration } from './project';

export const MORPH_TRANSITION_TYPE = 'morph';

/** Output frame rate for morph segments (preview + export). */
export const MORPH_SEGMENT_FPS = 30;

export function isMorphTransition(
  transition: ClipTransition | undefined,
): transition is ClipTransition {
  return Boolean(transition && transition.type === MORPH_TRANSITION_TYPE);
}

export function isMorphSegmentReady(transition: ClipTransition): boolean {
  return (
    isMorphTransition(transition) &&
    transition.morphSegment?.status === 'ready' &&
    Boolean(transition.morphSegment.objectUrl)
  );
}

/** Frame count for a morph segment spanning `durationSeconds` at MORPH_SEGMENT_FPS. */
export function morphFrameCountForDuration(durationSeconds: number): number {
  return Math.max(2, Math.round(durationSeconds * MORPH_SEGMENT_FPS));
}

export function morphClipId(afterClipIndex: number): string {
  return `__morph_${afterClipIndex}`;
}

export function createPendingMorphSegment(duration: number): MorphTransitionSegment {
  return {
    objectUrl: '',
    fileName: '',
    duration,
    status: 'pending',
  };
}

export function createGeneratingMorphSegment(
  duration: number,
  previous?: MorphTransitionSegment,
): MorphTransitionSegment {
  if (previous?.objectUrl) {
    URL.revokeObjectURL(previous.objectUrl);
  }
  return {
    objectUrl: '',
    fileName: '',
    duration,
    status: 'generating',
  };
}

export function createReadyMorphSegment(
  objectUrl: string,
  fileName: string,
  duration: number,
): MorphTransitionSegment {
  return {
    objectUrl,
    fileName,
    duration,
    status: 'ready',
  };
}

export function createFailedMorphSegment(
  duration: number,
  error: string,
  previous?: MorphTransitionSegment,
): MorphTransitionSegment {
  if (previous?.objectUrl) {
    URL.revokeObjectURL(previous.objectUrl);
  }
  return {
    objectUrl: '',
    fileName: '',
    duration,
    status: 'failed',
    error,
  };
}

/** User-facing fallback when the HF space is cold or times out. */
export function formatMorphFailureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/HTTP 503|cold|timeout|queue|complete event/i.test(raw)) {
    return (
      'Morph generation failed: the RIFE space may be cold or busy. ' +
      'Wait for it to finish loading and try again — preview will use a dissolve until then.'
    );
  }
  return `Morph generation failed: ${raw}. Preview will use a dissolve until a segment is ready.`;
}

export function shouldRegenerateMorph(
  prev: ClipTransition | undefined,
  next: ClipTransition,
): boolean {
  if (!isMorphTransition(next)) return false;
  if (next.duration <= 0) return false;
  if (next.morphSegment?.status === 'generating') return false;
  if (
    next.morphSegment?.status === 'ready' &&
    Math.abs((next.morphSegment.duration ?? 0) - next.duration) < 0.05
  ) {
    return false;
  }
  if (!prev || !isMorphTransition(prev)) return true;
  if (prev.duration !== next.duration) return true;
  if (prev.morphSegment?.status === 'failed') return true;
  if (prev.morphSegment?.status !== 'ready') return true;
  return false;
}

export function getMorphNeighborClips(
  transition: ClipTransition,
  timelineClips: Clip[],
): { clipA: Clip; clipB: Clip } | null {
  const index = transition.afterClipIndex;
  if (index < 1 || index >= timelineClips.length) return null;
  const clipA = timelineClips[index - 1];
  const clipB = timelineClips[index];
  if (clipA.kind !== 'video' || clipB.kind !== 'video') return null;
  if (getClipDuration(clipA) <= 0 || getClipDuration(clipB) <= 0) return null;
  return { clipA, clipB };
}
