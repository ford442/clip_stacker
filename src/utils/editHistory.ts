import type { Clip, ClipGroup, ClipTransition, TextOverlay } from '../types';

/** Maximum undo snapshots kept in memory. */
export const MAX_EDIT_HISTORY = 50;

/** Serializable editing state captured for undo/redo. */
export interface EditSnapshot {
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  selectedClipId: string | null;
}

/** Shallow-clone clip metadata while reusing File / objectUrl references. */
export function cloneClip(clip: Clip): Clip {
  return { ...clip };
}

export function cloneSnapshot(snapshot: EditSnapshot): EditSnapshot {
  return {
    clips: snapshot.clips.map(cloneClip),
    clipGroups: snapshot.clipGroups.map((group) => ({
      ...group,
      variants: {
        A: group.variants.A ? cloneClip(group.variants.A) : null,
        B: group.variants.B ? cloneClip(group.variants.B) : null,
      },
    })),
    transitions: snapshot.transitions.map((transition) => ({ ...transition })),
    textOverlays: snapshot.textOverlays.map((overlay) => ({ ...overlay })),
    selectedClipId: snapshot.selectedClipId,
  };
}

/**
 * Reuse live object URLs where possible; recreate from File when a clip was
 * restored after deletion (revoked URL).
 */
export function mergeClipUrls(restoredClips: Clip[], currentClips: Clip[]): Clip[] {
  const currentById = new Map(currentClips.map((clip) => [clip.id, clip]));

  return restoredClips.map((clip) => {
    const current = currentById.get(clip.id);
    if (current?.file === clip.file && current.objectUrl) {
      return { ...clip, objectUrl: current.objectUrl };
    }
    return { ...clip, objectUrl: URL.createObjectURL(clip.file) };
  });
}

/** Point clip-group variants at the canonical clips array after restore. */
export function syncClipGroups(groups: ClipGroup[], clips: Clip[]): ClipGroup[] {
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));

  return groups.map((group) => ({
    ...group,
    variants: {
      A: group.variants.A
        ? clipsById.get(group.variants.A.id) ?? mergeClipUrls([group.variants.A], clips)[0]
        : null,
      B: group.variants.B
        ? clipsById.get(group.variants.B.id) ?? mergeClipUrls([group.variants.B], clips)[0]
        : null,
    },
  }));
}

/** Revoke blob URLs for clips removed from the timeline. */
export function revokeOrphanedUrls(previousClips: Clip[], nextClips: Clip[]): void {
  const nextIds = new Set(nextClips.map((clip) => clip.id));
  for (const clip of previousClips) {
    if (!nextIds.has(clip.id)) {
      URL.revokeObjectURL(clip.objectUrl);
    }
  }
}

export function trimHistoryStack<T>(stack: T[], maxSize = MAX_EDIT_HISTORY): void {
  while (stack.length > maxSize) {
    stack.shift();
  }
}
