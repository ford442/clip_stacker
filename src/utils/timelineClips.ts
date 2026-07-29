import type { Clip, ClipGroup, ClipTransition, TextOverlay, Track } from '../types';
import { toLegacyTimelineView } from './trackModel';

/**
 * Return the clips that are currently on the timeline — resolving A/B groups
 * to their active variant.
 */
export function getTimelineClips(clips: Clip[], groups: ClipGroup[]): Clip[] {
  if (groups.length === 0) return clips;

  const inactiveGroupClipIds = new Set<string>();

  for (const group of groups) {
    const other = group.variants[group.activeVariant === 'A' ? 'B' : 'A'];
    if (other) inactiveGroupClipIds.add(other.id);
  }

  return clips.filter((clip) => !inactiveGroupClipIds.has(clip.id));
}

/**
 * Effective timeline clip order for preview/export when track placements exist.
 * Falls back to the flat clip list when tracks are empty.
 */
export function getEffectiveTimelineClips(
  tracks: Track[],
  clips: Clip[],
  groups: ClipGroup[],
): Clip[] {
  if (tracks.length === 0) {
    return getTimelineClips(clips, groups);
  }
  return toLegacyTimelineView(tracks, clips, groups);
}
