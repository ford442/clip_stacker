import type { Clip, Track } from '../../types';
import { baseLaneOrder, remapBaseTransitions, type EditState } from '../editModeCore';
import { createClipId, MIN_CLIP_DURATION } from '../media';
import { cloneTracks, findClipTrack } from '../trackBasics';
import { isClipLocked } from '../trackLanes';

/**
 * How far a processed segment may differ from the requested length (seconds).
 * Stream-copied cuts keep a few frames of B-frame delay; the surplus is trimmed
 * off on replace, so the clip on the timeline is exactly the segment long.
 */
export const SEGMENT_DURATION_TOLERANCE_SEC = 0.25;

const EPS = 1e-3;

/** The media that takes the segment's place. */
export interface SegmentMedia {
  file: File;
  objectUrl: string;
  /** Measured length of `file`. */
  durationSec: number;
  videoWidth?: number;
  videoHeight?: number;
  hasAudio?: boolean;
  /** Public URL when the media already lives in the remote library. */
  remoteUrl?: string;
}

export interface SegmentReplacement {
  /** Timeline clip the segment was cut from. */
  clipId: string;
  /** Source-media window being replaced (the numbers the SegmentRequest used). */
  startSec: number;
  endSec: number;
  media: SegmentMedia;
}

export type SegmentReplaceOutcome =
  | {
      ok: true;
      state: EditState;
      /** The clip now holding the processed media. */
      replacedClipId: string;
      /** Set when the source clip was split, so the caller can drop it from its A/B group. */
      splitSourceClip?: Clip;
      summary: string;
    }
  | { ok: false; reason: string };

function fail(reason: string): SegmentReplaceOutcome {
  return { ok: false, reason };
}

/** Source-time window the clip currently shows. */
function trimWindow(clip: Clip): { start: number; end: number } {
  return {
    start: clip.trimStart,
    end: Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration,
  };
}

/** Output time equals source time, so a sub-range can be cut out without retiming anything. */
function playsAtSourceSpeed(clip: Clip): boolean {
  return (
    (clip.playbackRate ?? 1) === 1 &&
    !clip.automation?.playbackRate?.length &&
    (clip.loopCount ?? 1) <= 1 &&
    !clip.reversed
  );
}

/** Fields derived from the old source's pixels or timeline; they do not carry to the new media. */
function withoutDerivedMediaData(clip: Clip): Clip {
  const next = { ...clip };
  delete next.stabilization;
  delete next.stabilizeError;
  delete next.proxy;
  delete next.remoteAudioUrl;
  delete next.beatTimestamps;
  delete next.bpmEstimate;
  delete next.bpmConfidence;
  delete next.lumaHistogram;
  delete next.lumaLevels;
  delete next.posterUrl;
  return next;
}

/**
 * Swap `replacement.media` in for the window `[startSec, endSec]` of a timeline
 * clip, keeping every other item exactly where it was.
 *
 * - Window == the clip's whole trim range: the clip keeps its id and slot; only
 *   its media changes (same as the RIFE swap).
 * - Window strictly inside: the clip is cut into `[before][replaced][after]`
 *   on the same lane at the same output times. Only for clips that play at
 *   source speed, because that is what makes source seconds equal timeline
 *   seconds.
 *
 * The replaced clip is trimmed to exactly `endSec - startSec`, so the lane
 * length cannot change even when the media is a few frames long.
 */
export function planSegmentReplacement(
  state: EditState,
  replacement: SegmentReplacement,
): SegmentReplaceOutcome {
  const { clipId, startSec, endSec, media } = replacement;
  const clip = state.clips.find((c) => c.id === clipId);
  if (!clip) return fail('The clip this segment came from is no longer on the timeline.');
  if (clip.stillImage) return fail('Still images have no segments to replace.');
  if (isClipLocked(state.tracks, clipId)) {
    return fail('Track is locked — unlock the lane to replace a segment.');
  }
  const placed = findClipTrack(state.tracks, clipId);
  if (!placed) return fail('The clip this segment came from is not placed on a track.');

  const length = endSec - startSec;
  if (!Number.isFinite(length) || length < MIN_CLIP_DURATION) {
    return fail(`A segment must be at least ${MIN_CLIP_DURATION}s long.`);
  }
  if (Math.abs(media.durationSec - length) > SEGMENT_DURATION_TOLERANCE_SEC) {
    return fail(
      `The result is ${media.durationSec.toFixed(2)}s but the segment is ${length.toFixed(2)}s. ` +
        'It has to match so the timeline does not shift and a later lossless join stays possible.',
    );
  }

  const window = trimWindow(clip);
  if (startSec < window.start - EPS || endSec > window.end + EPS) {
    return fail(
      `The segment ${startSec.toFixed(2)}–${endSec.toFixed(2)}s is outside the clip's trimmed range ` +
        `${window.start.toFixed(2)}–${window.end.toFixed(2)}s.`,
    );
  }

  const before = Math.max(0, startSec - window.start);
  const after = Math.max(0, window.end - endSec);
  const hasLeft = before > EPS;
  const hasRight = after > EPS;
  if ((hasLeft && before < MIN_CLIP_DURATION) || (hasRight && after < MIN_CLIP_DURATION)) {
    return fail(
      `Leave at least ${MIN_CLIP_DURATION}s of the clip on each side of the segment, or select its whole trimmed range.`,
    );
  }
  const whole = !hasLeft && !hasRight;
  if (!whole && !playsAtSourceSpeed(clip)) {
    return fail(
      'This clip is sped up, looped, reversed or has speed automation, so a part of it cannot be swapped in place. ' +
        'Select its whole trimmed range instead.',
    );
  }

  const trimmed = withoutDerivedMediaData(clip);
  const swapped: Clip = {
    ...trimmed,
    // The first piece of the lane keeps the source id so a base transition into it survives.
    id: hasLeft ? createClipId() : clip.id,
    title: whole ? clip.title : `${clip.title} (processed)`,
    file: media.file,
    objectUrl: media.objectUrl,
    duration: media.durationSec,
    trimStart: 0,
    trimEnd: length,
    ...(media.videoWidth ? { videoWidth: media.videoWidth } : {}),
    ...(media.videoHeight ? { videoHeight: media.videoHeight } : {}),
    ...(media.hasAudio !== undefined ? { hasAudio: media.hasAudio } : {}),
    remoteSourceUrl: media.remoteUrl,
    // Source-relative markers: keep the ones inside the window, re-based to the new media.
    syncMarkers: clip.syncMarkers
      ?.filter((m) => m.time >= startSec && m.time <= endSec)
      .map((m) => ({ ...m, time: m.time - startSec })),
  };
  if (!swapped.syncMarkers?.length) delete swapped.syncMarkers;
  if (!swapped.remoteSourceUrl) delete swapped.remoteSourceUrl;
  if (!whole) {
    swapped.groupId = undefined;
    swapped.groupVariant = undefined;
  }

  const pieces: Clip[] = [];
  const itemStart = placed.track.items[placed.itemIndex].startTime;
  const items: Track['items'] = [];

  if (hasLeft) {
    pieces.push({ ...clip, trimEnd: startSec, groupId: undefined, groupVariant: undefined });
    items.push({ clipId: clip.id, startTime: itemStart });
  }
  pieces.push(swapped);
  items.push({ clipId: swapped.id, startTime: itemStart + before });
  if (hasRight) {
    const right: Clip = {
      ...clip,
      id: createClipId(),
      title: `${clip.title} (split)`,
      trimStart: endSec,
      groupId: undefined,
      groupVariant: undefined,
    };
    pieces.push(right);
    items.push({ clipId: right.id, startTime: itemStart + before + length });
  }

  const tracks = cloneTracks(state.tracks);
  tracks[placed.trackIndex].items.splice(placed.itemIndex, 1, ...items);

  const clips = state.clips.flatMap((c) => (c.id === clip.id ? pieces : [c]));
  const rightPiece = hasRight ? pieces[pieces.length - 1] : undefined;
  const transitions = remapBaseTransitions(
    baseLaneOrder(state.tracks),
    baseLaneOrder(tracks),
    state.transitions,
    // A cross-fade out of the source follows its tail.
    rightPiece ? new Map([[rightPiece.id, clip.id]]) : new Map(),
  );

  const where = whole
    ? `"${clip.title}"`
    : `${startSec.toFixed(2)}–${endSec.toFixed(2)}s of "${clip.title}"`;
  return {
    ok: true,
    state: { tracks, clips, transitions },
    replacedClipId: swapped.id,
    ...(whole ? {} : { splitSourceClip: clip }),
    summary: `Replaced ${where} with the processed segment.`,
  };
}
