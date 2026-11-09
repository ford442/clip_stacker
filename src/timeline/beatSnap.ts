import type { Clip } from '../types';
import { beatsInTrimWindow } from './beatMarkers';

/** Default snap threshold in milliseconds. */
export const DEFAULT_BEAT_SNAP_THRESHOLD_MS = 100;

/**
 * Snap an absolute time (seconds) to the nearest beat within a threshold.
 * Returns the snapped time, or null when no beat is close enough.
 */
export function snapTimeToBeat(
  timeSec: number,
  beats: number[],
  thresholdMs = DEFAULT_BEAT_SNAP_THRESHOLD_MS,
): number | null {
  if (!beats.length || !Number.isFinite(timeSec)) return null;

  const thresholdSec = thresholdMs / 1000;
  let best: number | null = null;
  let bestDist = thresholdSec;

  for (const beat of beats) {
    if (!Number.isFinite(beat)) continue;
    const dist = Math.abs(beat - timeSec);
    if (dist <= bestDist) {
      bestDist = dist;
      best = beat;
    }
  }

  return best;
}

/**
 * Snap a split point (absolute media time) to the nearest beat in the clip.
 * Returns the snapped split time, or the original when no beat is within range.
 */
export function snapSplitTimeToBeat(
  clip: Clip,
  splitTimeSec: number,
  thresholdMs = DEFAULT_BEAT_SNAP_THRESHOLD_MS,
): number {
  const beats = beatsInTrimWindow(clip);
  const snapped = snapTimeToBeat(splitTimeSec, beats, thresholdMs);
  return snapped ?? splitTimeSec;
}
