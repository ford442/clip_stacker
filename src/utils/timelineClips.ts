import type { Clip, ClipGroup } from '../types';

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
