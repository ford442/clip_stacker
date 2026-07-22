import type { Clip } from '../types';
import type { VirtualClipLayout } from '../components/timelineClipTypes';

export interface BeatMarkerLayout {
  clipId: string;
  /** Beat time in source media seconds. */
  sourceTime: number;
  /** Pixel offset from the left of the timeline track. */
  leftPx: number;
}

/**
 * Map clip beatTimestamps onto timeline ruler pixel positions (read-only overlay).
 * Beats outside the trimmed range are skipped.
 */
export function buildBeatMarkerLayouts(
  layouts: VirtualClipLayout[],
): BeatMarkerLayout[] {
  const markers: BeatMarkerLayout[] = [];
  for (const layout of layouts) {
    const { clip, duration, width, start } = layout;
    const beats = clip.beatTimestamps;
    if (!beats || beats.length === 0 || duration <= 0) continue;

    const trimStart = clip.trimStart;
    const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const pxPerSec = width / duration;

    for (const t of beats) {
      if (!Number.isFinite(t) || t < trimStart || t > trimEnd) continue;
      const local = t - trimStart;
      markers.push({
        clipId: clip.id,
        sourceTime: t,
        leftPx: start + local * pxPerSec,
      });
    }
  }
  return markers;
}

/** Collect beats visible in a single clip's trimmed window (source seconds). */
export function beatsInTrimWindow(clip: Clip): number[] {
  const beats = clip.beatTimestamps;
  if (!beats?.length) return [];
  const trimStart = clip.trimStart;
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  return beats.filter((t) => Number.isFinite(t) && t >= trimStart && t <= trimEnd);
}
