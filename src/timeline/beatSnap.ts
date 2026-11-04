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

/**
 * Snap a transition edge (output-timeline seconds) to the nearest beat from
 * any clip with beat metadata. Returns the snapped time or the original.
 */
export function snapTransitionEdgeToBeat(
  outputTimeSec: number,
  clips: Clip[],
  clipOutputStarts: Map<string, number>,
  thresholdMs = DEFAULT_BEAT_SNAP_THRESHOLD_MS,
): number {
  let best: number | null = null;
  let bestDist = thresholdMs / 1000;

  for (const clip of clips) {
    const beats = beatsInTrimWindow(clip);
    if (!beats.length) continue;
    const clipStart = clipOutputStarts.get(clip.id) ?? 0;
    for (const beat of beats) {
      const outputBeat = clipStart + (beat - clip.trimStart);
      const dist = Math.abs(outputBeat - outputTimeSec);
      if (dist <= bestDist) {
        bestDist = dist;
        best = outputBeat;
      }
    }
  }

  return best ?? outputTimeSec;
}
