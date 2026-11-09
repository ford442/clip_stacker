import type { Clip, ClipGroup } from '../types';
import { createClipId, MIN_CLIP_DURATION } from '../media/media';
import { sanitizeClipAdjustments } from '../project';

/** Shallow-copy a clip with a new ID, reusing the same media file and object URL. */
export function duplicateClip(clip: Clip): Clip {
  const { groupId: _groupId, groupVariant: _groupVariant, ...ungrouped } = clip;
  const copy: Clip = {
    ...ungrouped,
    id: createClipId(),
    title: clip.title.trim() ? `${clip.title} (copy)` : `${clip.file.name} (copy)`,
  };
  sanitizeClipAdjustments(copy);
  return copy;
}

function clipTrimEnd(clip: Clip): number {
  return Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
}

/**
 * Split a clip at an absolute media timestamp.
 * Returns [left, right] or null when the split point is too close to trim edges.
 */
export function splitClipAt(clip: Clip, splitTime: number): [Clip, Clip] | null {
  const trimEnd = clipTrimEnd(clip);
  const minTime = clip.trimStart + MIN_CLIP_DURATION;
  const maxTime = trimEnd - MIN_CLIP_DURATION;

  if (!Number.isFinite(splitTime) || splitTime <= minTime || splitTime >= maxTime) {
    return null;
  }

  const { groupId: _groupId, groupVariant: _groupVariant, ...ungrouped } = clip;
  const left: Clip = {
    ...ungrouped,
    trimEnd: splitTime,
  };

  const right: Clip = {
    ...ungrouped,
    id: createClipId(),
    title: clip.title.trim() ? `${clip.title} (split)` : `${clip.file.name} (split)`,
    trimStart: splitTime,
    trimEnd: clip.trimEnd,
  };

  sanitizeClipAdjustments(left);
  sanitizeClipAdjustments(right);
  return [left, right];
}

/** Remove a clip from any A/B group bookkeeping after split or ungrouped edits. */
export function removeClipFromGroups(groups: ClipGroup[], clip: Clip): ClipGroup[] {
  if (!clip.groupId) return groups;

  return groups
    .map((group) => {
      if (group.id !== clip.groupId) return group;
      if (clip.groupVariant === 'A') {
        return { ...group, variants: { ...group.variants, A: null } };
      }
      if (clip.groupVariant === 'B') {
        return { ...group, variants: { ...group.variants, B: null } };
      }
      return group;
    })
    .filter((group) => group.variants.A !== null || group.variants.B !== null);
}
