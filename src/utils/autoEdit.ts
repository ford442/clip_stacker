import type { Clip, ClipTransition, Track } from '../types';
import { beatsInTrimWindow } from './beatMarkers';
import {
  cloneTracks,
  createDefaultTracks,
  MAIN_VIDEO_TRACK_ID,
  toLegacyTimelineView,
} from './trackModel';
import { duplicateClip } from './clipOperations';
import { buildClipTimelineSegments } from './previewComposition';

export interface AutoCutResult {
  /** New track placements (non-destructive copy). */
  tracks: Track[];
  /** Clips including any duplicates created for the arrangement. */
  clips: Clip[];
  /** Transitions for the new main-sequence cuts. */
  transitions: ClipTransition[];
}

function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

/**
 * "Auto cut to music": place B-roll segment boundaries on strong beat onsets.
 * Non-destructive — returns a new track arrangement without modifying source clips.
 * No-op (returns input unchanged) when the reference clip has no beatTimestamps.
 */
export function autoCutToMusic(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
  referenceClipId: string,
  brollClipIds: string[],
): AutoCutResult {
  const reference = clips.find((c) => c.id === referenceClipId);
  const beats = reference ? beatsInTrimWindow(reference) : [];
  if (!beats.length || brollClipIds.length === 0) {
    return { tracks: cloneTracks(tracks), clips: [...clips], transitions: [...transitions] };
  }

  const brollClips = brollClipIds
    .map((id) => clips.find((c) => c.id === id))
    .filter((c): c is Clip => c != null);
  if (!brollClips.length) {
    return { tracks: cloneTracks(tracks), clips: [...clips], transitions: [...transitions] };
  }

  const newClips: Clip[] = [...clips];
  const newTracks = cloneTracks(tracks.length > 0 ? tracks : createDefaultTracks());
  const mainTrack =
    newTracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)
    ?? newTracks.find((t) => t.kind === 'video');
  if (!mainTrack) {
    return { tracks: newTracks, clips: newClips, transitions: [...transitions] };
  }

  // Clear main track items for the new arrangement
  mainTrack.items = [];

  const legacy = toLegacyTimelineView(tracks, clips);
  const baseClips = legacy.filter(isBaseClip);
  const refIndex = baseClips.findIndex((c) => c.id === referenceClipId);
  const refStart = refIndex >= 0
    ? buildClipTimelineSegments(
        baseClips,
        transitions,
        baseClips.map((_, i) => i),
      ).find((s) => s.clip.id === referenceClipId)?.startTime ?? 0
    : 0;

  let brollIndex = 0;

  for (let i = 0; i < beats.length - 1; i++) {
    const beatStart = beats[i];
    const beatEnd = beats[i + 1];
    const segmentDuration = beatEnd - beatStart;
    if (segmentDuration < 0.1) continue;

    const broll = brollClips[brollIndex % brollClips.length];
    brollIndex += 1;

    const segment = duplicateClip(broll);
    segment.trimStart = broll.trimStart;
    segment.trimEnd = Math.min(
      Number.isFinite(broll.trimEnd) ? broll.trimEnd : broll.duration,
      broll.trimStart + segmentDuration,
    );
    newClips.push(segment);

    mainTrack.items.push({
      clipId: segment.id,
      startTime: refStart + (beatStart - (reference?.trimStart ?? 0)),
    });
  }

  if (mainTrack.items.length === 0) {
    return { tracks: cloneTracks(tracks), clips: [...clips], transitions: [...transitions] };
  }

  // Hard cuts between beat segments
  const newTransitions: ClipTransition[] = mainTrack.items.slice(1).map((_, i) => ({
    afterClipIndex: i + 1,
    type: 'none' as const,
    duration: 0,
  }));

  return {
    tracks: newTracks,
    clips: newClips,
    transitions: newTransitions,
  };
}

/** Whether auto-cut can run for the given reference clip. */
export function canAutoCutToMusic(clips: Clip[], referenceClipId: string): boolean {
  const reference = clips.find((c) => c.id === referenceClipId);
  return Boolean(reference && beatsInTrimWindow(reference).length > 1);
}
