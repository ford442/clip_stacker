import type { Clip, ClipGroup, Track } from '../types';
import { createClipId } from './media';
import { findMatchingClipIndex } from './clipMatching';
import { appendClipToTracks } from './trackModel';

export interface AddClipPlan {
  clips: Clip[];
  tracks?: Track[];
  clipGroups?: ClipGroup[];
}

/**
 * Pure plan for adding a clip to the editor store. Keeps clips, tracks, and
 * clip groups consistent without nested state updaters (React #185).
 */
export function planAddClip(
  prevClips: Clip[],
  prevTracks: Track[],
  prevGroups: ClipGroup[],
  newClip: Clip,
): AddClipPlan {
  const existingNames = prevClips.map((c) => c.file.name);
  const matchIndex = findMatchingClipIndex(existingNames, newClip.file.name);

  if (matchIndex >= 0) {
    const matchedClip = prevClips[matchIndex];
    const groupId = matchedClip.groupId ?? createClipId();

    const existingGroup = prevGroups.find((g) => g.id === groupId);
    const nextGroups = existingGroup
      ? prevGroups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                variants: {
                  ...g.variants,
                  B: { ...newClip, groupId, groupVariant: 'B' as const },
                },
              }
            : g,
        )
      : [
          ...prevGroups,
          {
            id: groupId,
            variants: {
              A: { ...matchedClip, groupId, groupVariant: 'A' as const },
              B: { ...newClip, groupId, groupVariant: 'B' as const },
            },
            activeVariant: 'A' as const,
          },
        ];

    const taggedMatch = {
      ...matchedClip,
      groupId,
      groupVariant: 'A' as const,
    };
    const taggedNew = { ...newClip, groupId, groupVariant: 'B' as const };
    const nextClips = prevClips
      .map((c, i) => (i === matchIndex ? taggedMatch : c))
      .concat(taggedNew);

    return { clips: nextClips, clipGroups: nextGroups };
  }

  const nextClips = [...prevClips, newClip];
  const nextTracks = appendClipToTracks(prevTracks, newClip, nextClips);
  return { clips: nextClips, tracks: nextTracks };
}
