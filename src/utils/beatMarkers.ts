import type { Clip, MasterAudio } from '../types';
import type { VirtualClipLayout } from '../components/timelineClipTypes';
import { getClipPlaybackRate } from './playbackRate';
import {
  clipHasRateAutomation,
  outputLocalAtSourceOffset,
} from './timeRemap';

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
 * Source beat times are mapped through constant playbackRate or the variable
 * rate automation curve onto the output clip span.
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
    const hasCurve = clipHasRateAutomation(clip);
    const rate = getClipPlaybackRate(clip);

    for (const t of beats) {
      if (!Number.isFinite(t) || t < trimStart || t > trimEnd) continue;
      const local = hasCurve
        ? outputLocalAtSourceOffset(clip, t - trimStart)
        : (t - trimStart) / rate;
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

export interface MasterBeatMarkerLayout {
  /** Beat time in seconds from the start of the master audio file. */
  sourceTime: number;
  /** Beat time in timeline seconds (source time + master `startTime`). */
  timelineTime: number;
  /** Pixel offset from the left of the timeline content. */
  leftPx: number;
}

/**
 * Master-lane sibling of {@link buildBeatMarkerLayouts}. The master track is
 * never time-stretched, so beats map straight through its timeline offset.
 */
export function buildMasterBeatMarkerLayouts(
  masterAudio: Pick<MasterAudio, 'startTime' | 'duration' | 'beatTimestamps'> | null,
  pixelsPerSecond: number,
): MasterBeatMarkerLayout[] {
  const beats = masterAudio?.beatTimestamps;
  if (!masterAudio || !beats?.length || !(pixelsPerSecond > 0)) return [];

  const markers: MasterBeatMarkerLayout[] = [];
  for (const t of beats) {
    if (!Number.isFinite(t) || t < 0 || t > masterAudio.duration) continue;
    const timelineTime = masterAudio.startTime + t;
    markers.push({
      sourceTime: t,
      timelineTime,
      leftPx: timelineTime * pixelsPerSecond,
    });
  }
  return markers;
}
