import type { Clip, ClipGroup, Track } from '../types';
import { getEffectiveTimelineClips } from '../timeline/trackModel';

/** The editor fields the timeline-clip derivation reads. */
export interface TimelineClipInputs {
  tracks: Track[];
  clips: Clip[];
  clipGroups: ClipGroup[];
}

let memo: { tracks: Track[]; clips: Clip[]; clipGroups: ClipGroup[]; result: Clip[] } | null = null;

/**
 * The clips on the timeline (active A/B variant per group, track order, with
 * the derived placement fields stamped on) — the one derivation every
 * caller uses. Memoized on the identity of its three inputs, so the store
 * hook, the action hooks and `getState()` readers share one array per edit.
 */
export function selectTimelineClips(state: TimelineClipInputs): Clip[] {
  if (
    memo &&
    memo.tracks === state.tracks &&
    memo.clips === state.clips &&
    memo.clipGroups === state.clipGroups
  ) {
    return memo.result;
  }
  const result = getEffectiveTimelineClips(state.tracks, state.clips, state.clipGroups);
  memo = { tracks: state.tracks, clips: state.clips, clipGroups: state.clipGroups, result };
  return result;
}
