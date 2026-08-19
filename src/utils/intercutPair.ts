import type { Clip, ClipGroup } from '../types';

/**
 * Default A/B pair for the Intercut modal: prefer the selected clip's variant
 * group, otherwise the selected video plus another library video. Clip C is
 * left empty so two-clip intercuts stay the default.
 */
export function defaultIntercutPair(
  clips: Clip[],
  clipGroups: ClipGroup[],
  selectedClipId: string | null,
): { clipAId: string | null; clipBId: string | null; clipCId: string | null } {
  const video = clips.filter((c) => c.kind === 'video');
  const selected = clips.find((c) => c.id === selectedClipId) ?? null;

  if (selected?.groupId) {
    const group = clipGroups.find((g) => g.id === selected.groupId);
    const idA = group?.variants.A?.id ?? null;
    const idB = group?.variants.B?.id ?? null;
    if (idA && idB && idA !== idB) {
      return { clipAId: idA, clipBId: idB, clipCId: null };
    }
  }

  if (selected && selected.kind === 'video') {
    const other = video.find((c) => c.id !== selected.id) ?? null;
    return { clipAId: selected.id, clipBId: other?.id ?? null, clipCId: null };
  }

  return {
    clipAId: video[0]?.id ?? null,
    clipBId: video[1]?.id ?? null,
    clipCId: null,
  };
}
