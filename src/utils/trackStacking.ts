import type { Clip, Track } from '../types';
// Imported from the submodule rather than the `./project` barrel: the barrel
// pulls in `applyProjectData`, which imports `trackModel`, which imports this
// file — a cycle that would leave `getClipDuration` undefined at module init.
import { getClipDuration } from './project/clipHelpers';

/**
 * Track-driven video stacking (#168 follow-up, Phase B).
 *
 * This is the single place that answers "which video sits on top of which, and
 * when does it appear?". The rules are:
 *
 * - **Stacking order is track order.** The first video track in `tracks` is the
 *   base sequence (V1, bottom); each subsequent video track composites above it.
 *   `Clip.layerIndex` is *derived* from that index for the FFmpeg / legacy
 *   filter-graph path — it is no longer an independent authoring control.
 * - **`TrackItem.startTime` is the output timestamp for every video track**, not
 *   only the base sequence. An overlay placed at t=5s appears at 5s and ends at
 *   5s + its trimmed duration, rather than being forced to output time 0.
 *
 * Base-sequence timing is the one exception: V1 items participate in xfade
 * transition overlap math, so `buildClipTimelineSegments` owns their start
 * times and the base placements here are reported at their authored
 * `TrackItem.startTime` only for ordering purposes.
 */

/** One video placement resolved against the track stack. */
export interface StackedVideoPlacement {
  clip: Clip;
  trackId: string;
  /**
   * Index among video tracks, bottom-up. 0 = base sequence (composites full
   * frame), 1+ = overlay. Mirrors the legacy `Clip.layerIndex`.
   */
  layerIndex: number;
  /** Output-timeline start in seconds (`TrackItem.startTime`). */
  startTime: number;
  /** Trimmed output duration in seconds. */
  duration: number;
  /** Holding track's mute flag — audio is dropped from the mix when true. */
  muted: boolean;
  /** Holding track's lock flag — trim / drag / delete are blocked when true. */
  locked: boolean;
}

/** Video tracks in stacking order (bottom first). */
function orderedVideoTracks(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.kind === 'video');
}

/**
 * Every video placement across the track stack, ordered bottom track first and
 * by `startTime` within a track.
 *
 * `timelineClips` must already be A/B-group resolved (see `getTimelineClips`);
 * placements whose clip is not in that list are skipped.
 */
export function buildVideoStack(
  tracks: Track[],
  timelineClips: Clip[],
): StackedVideoPlacement[] {
  const clipMap = new Map(timelineClips.map((c) => [c.id, c]));
  const placements: StackedVideoPlacement[] = [];

  const vTracks = orderedVideoTracks(tracks);
  for (let layerIndex = 0; layerIndex < vTracks.length; layerIndex++) {
    const track = vTracks[layerIndex];
    const sorted = [...track.items].sort((a, b) => a.startTime - b.startTime);
    for (const item of sorted) {
      const clip = clipMap.get(item.clipId);
      if (!clip) continue;
      placements.push({
        clip,
        trackId: track.id,
        layerIndex,
        startTime: item.startTime,
        duration: getClipDuration(clip),
        muted: Boolean(track.muted),
        locked: Boolean(track.locked),
      });
    }
  }

  return placements;
}

/**
 * The video placements visible at output time `time`, in stacking order
 * (bottom-most first, so a caller can draw them in array order).
 *
 * Base-sequence (`layerIndex === 0`) placements are excluded: their visibility
 * is governed by transition-aware segment math in `previewComposition.ts`, not
 * by a bare `[startTime, startTime + duration)` window.
 */
export function stackFromTracks(
  tracks: Track[],
  timelineClips: Clip[],
  time: number,
): StackedVideoPlacement[] {
  return buildVideoStack(tracks, timelineClips).filter(
    (placement) =>
      placement.layerIndex > 0 &&
      placement.duration > 0 &&
      time >= placement.startTime &&
      time < placement.startTime + placement.duration,
  );
}

/**
 * Stamp derived placement fields onto a clip for the flattened timeline view.
 * Returns the same object when nothing would change so downstream memoized
 * selectors keep their reference equality.
 */
export function withPlacement(
  clip: Clip,
  placement: Pick<
    StackedVideoPlacement,
    'layerIndex' | 'startTime' | 'muted' | 'locked'
  >,
): Clip {
  const muted = placement.muted ? true : undefined;
  const locked = placement.locked ? true : undefined;
  if (
    (clip.layerIndex ?? 0) === placement.layerIndex &&
    clip.timelineStart === placement.startTime &&
    clip.trackMuted === muted &&
    clip.trackLocked === locked
  ) {
    return clip;
  }
  const next: Clip = {
    ...clip,
    layerIndex: placement.layerIndex,
    timelineStart: placement.startTime,
  };
  if (muted) next.trackMuted = true;
  else delete next.trackMuted;
  if (locked) next.trackLocked = true;
  else delete next.trackLocked;
  return next;
}

/**
 * Output time window a non-base placement occupies, using the derived
 * `timelineStart` stamped by {@link withPlacement}. Legacy clips (no track
 * placement) fall back to output time 0, which is where the pre-track PiP
 * pipeline put them.
 */
export function placementWindow(clip: Clip, duration: number): {
  start: number;
  end: number;
} {
  const start = Math.max(0, clip.timelineStart ?? 0);
  return { start, end: start + duration };
}
