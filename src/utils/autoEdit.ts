import type { Clip, ClipTransition, MasterAudio, Track } from '../types';
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

/**
 * A tempo reference for auto-cutting: where its beats sit, and how its own
 * source time maps onto the output timeline.
 *
 * Both supported references reduce to this shape, so the cutting logic below
 * doesn't care which one the user picked:
 *
 * - a **clip** with `beatTimestamps` — beats in the clip's source seconds,
 *   `sourceOrigin` is its `trimStart` and `outputStart` its segment start;
 * - the **master audio** track — beats in file seconds, `sourceOrigin` 0 and
 *   `outputStart` the master lane's timeline offset.
 */
export interface AutoCutReference {
  /** Beat onsets in the reference's own source seconds, ascending. */
  beats: number[];
  /** Source time that `outputStart` corresponds to. */
  sourceOrigin: number;
  /** Output time the reference begins at. */
  outputStart: number;
  /** Human-readable name for status messages. */
  label: string;
}

function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

function unchanged(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
): AutoCutResult {
  return {
    tracks: cloneTracks(tracks),
    clips: [...clips],
    transitions: [...transitions],
  };
}

/** Output time of a base-sequence clip, accounting for transition overlaps. */
function baseSequenceStart(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
  clipId: string,
): number {
  const baseClips = toLegacyTimelineView(tracks, clips).filter(isBaseClip);
  if (!baseClips.some((c) => c.id === clipId)) return 0;
  const segments = buildClipTimelineSegments(
    baseClips,
    transitions,
    baseClips.map((_, i) => i),
  );
  return segments.find((s) => s.clip.id === clipId)?.startTime ?? 0;
}

/** Tempo reference from a clip's detected beats, or null when it has none. */
export function resolveClipAutoCutReference(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
  clipId: string,
): AutoCutReference | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const beats = beatsInTrimWindow(clip);
  if (beats.length < 2) return null;
  return {
    beats,
    sourceOrigin: clip.trimStart,
    outputStart: baseSequenceStart(tracks, clips, transitions, clipId),
    label: clip.title,
  };
}

/** Tempo reference from the master audio lane, or null when it has no beats. */
export function resolveMasterAutoCutReference(
  masterAudio: MasterAudio | null,
): AutoCutReference | null {
  const beats = (masterAudio?.beatTimestamps ?? []).filter((t) => Number.isFinite(t));
  if (!masterAudio || beats.length < 2) return null;
  return {
    beats: [...beats].sort((a, b) => a - b),
    sourceOrigin: 0,
    outputStart: Math.max(0, masterAudio.startTime),
    label: masterAudio.fileName,
  };
}

/**
 * "Auto cut to music": lay B-roll segments onto the main video lane so every cut
 * lands on a beat of `reference`.
 *
 * Non-destructive — source clips are untouched and the result is a new
 * arrangement the caller applies in one undoable step. Returns the inputs
 * unchanged when there is nothing to cut (fewer than two beats, or no B-roll).
 */
export function autoCutFromReference(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
  reference: AutoCutReference | null,
  brollClipIds: string[],
): AutoCutResult {
  const beats = reference?.beats ?? [];
  if (!reference || beats.length < 2 || brollClipIds.length === 0) {
    return unchanged(tracks, clips, transitions);
  }

  const brollClips = brollClipIds
    .map((id) => clips.find((c) => c.id === id))
    .filter((c): c is Clip => c != null);
  if (!brollClips.length) return unchanged(tracks, clips, transitions);

  const newClips: Clip[] = [...clips];
  const newTracks = cloneTracks(tracks.length > 0 ? tracks : createDefaultTracks());
  const mainTrack =
    newTracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)
    ?? newTracks.find((t) => t.kind === 'video');
  if (!mainTrack) return unchanged(tracks, clips, transitions);
  if (mainTrack.locked) return unchanged(tracks, clips, transitions);

  // Clear main track items for the new arrangement
  mainTrack.items = [];

  let brollIndex = 0;

  for (let i = 0; i < beats.length - 1; i++) {
    const beatStart = beats[i];
    const segmentDuration = beats[i + 1] - beatStart;
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
      startTime: Math.max(
        0,
        reference.outputStart + (beatStart - reference.sourceOrigin),
      ),
    });
  }

  if (mainTrack.items.length === 0) return unchanged(tracks, clips, transitions);

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

/**
 * Auto-cut against a clip reference. Kept as the original entry point;
 * {@link autoCutFromReference} additionally accepts the master audio lane.
 */
export function autoCutToMusic(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
  referenceClipId: string,
  brollClipIds: string[],
): AutoCutResult {
  return autoCutFromReference(
    tracks,
    clips,
    transitions,
    resolveClipAutoCutReference(tracks, clips, transitions, referenceClipId),
    brollClipIds,
  );
}

/** Whether auto-cut can run for the given reference clip. */
export function canAutoCutToMusic(clips: Clip[], referenceClipId: string): boolean {
  const reference = clips.find((c) => c.id === referenceClipId);
  return Boolean(reference && beatsInTrimWindow(reference).length > 1);
}
