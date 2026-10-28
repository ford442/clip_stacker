import type { Clip, ClipGroup, ClipTransition, Track, TrackItem } from '../types';
import { createClipId } from './media';
import { getClipDuration } from './clipTiming';
import { buildClipTimelineSegments } from './previewComposition';
import { getTimelineClips } from './timelineClips';
import { buildVideoStack, withPlacement } from './trackStacking';
import { computeTotalDuration } from './transitions';
import {
  audioTracks,
  clipById,
  cloneTrack,
  cloneTracks,
  computeTrackEnd,
  createDefaultTracks,
  DEFAULT_TRACK_HEIGHT,
  DEFAULT_VIDEO_LABEL,
  findClipTrack,
  isBaseClip,
  MAIN_AUDIO_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  OVERLAY_VIDEO_TRACK_ID,
  videoTracks,
} from './trackBasics';
import { acceptsClipKind, addTrack } from './trackLanes';

// Lane primitives (`trackBasics`), lane chrome (`trackLanes`) and titles-lane
// helpers (`titleTracks`) live in sibling modules; re-exported here so this
// stays the one import for track edits.
export {
  audioTracks,
  clipById,
  cloneTracks,
  createDefaultTracks,
  DEFAULT_TRACK_HEIGHT,
  findClipTrack,
  getTrackClips,
  MAIN_AUDIO_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  OVERLAY_VIDEO_TRACK_ID,
  videoTracks,
} from './trackBasics';
export {
  acceptsClipKind,
  addTrack,
  canRemoveTrack,
  isClipLocked,
  nextTrackLabel,
  removeTrack,
  renameTrack,
  setTrackAudioFx,
  setTrackDuck,
  setTrackHeight,
  setTrackLocked,
  setTrackMuted,
  trackForClip,
} from './trackLanes';
export {
  isTextOverlayLocked,
  placeTextOverlayOnTrack,
  removeTextOverlayFromTracks,
  textTrackOverlayIds,
  visibleTextOverlays,
} from './titleTracks';

/**
 * Migrate a legacy flat clip list (array order + layerIndex) into track placements.
 * Base-layer clips land on the main video track with sequential start times;
 * PiP overlays land on overlay video tracks; the audio track starts empty.
 */
export function migrateLegacyClipsToTracks(
  clips: Clip[],
  transitions: ClipTransition[],
  groups: ClipGroup[] = [],
): Track[] {
  const timelineClips = getTimelineClips(clips, groups);
  const baseClips = timelineClips.filter(isBaseClip);
  const overlayClips = timelineClips.filter((c) => !isBaseClip(c));

  const timelineIndices = baseClips.map((clip) => timelineClips.indexOf(clip));
  const segments = buildClipTimelineSegments(baseClips, transitions, timelineIndices);

  const mainItems: TrackItem[] = segments.map((seg) => ({
    clipId: seg.clip.id,
    startTime: seg.startTime,
  }));

  const tracks = createDefaultTracks();
  tracks[0] = { ...tracks[0], items: mainItems };

  if (overlayClips.length > 0) {
    const byLayer = new Map<number, Clip[]>();
    for (const clip of overlayClips) {
      const layer = clip.layerIndex ?? 1;
      const list = byLayer.get(layer) ?? [];
      list.push(clip);
      byLayer.set(layer, list);
    }

    const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
    for (let i = 0; i < layerKeys.length; i++) {
      const layer = layerKeys[i];
      const overlayItems: TrackItem[] = (byLayer.get(layer) ?? []).map((clip) => ({
        clipId: clip.id,
        startTime: 0,
      }));

      if (i === 0) {
        tracks[1] = { ...tracks[1], items: overlayItems };
      } else {
        tracks.push({
          id: createClipId(),
          kind: 'video',
          label: `${DEFAULT_VIDEO_LABEL} ${i + 2}`,
          items: overlayItems,
          height: DEFAULT_TRACK_HEIGHT,
        });
      }
    }
  }

  return tracks;
}

/**
 * Build tracks from serialized v1 data, or migrate from legacy clips when absent.
 */
export function resolveProjectTracks(
  savedTracks: Track[] | undefined,
  clips: Clip[],
  transitions: ClipTransition[],
  groups: ClipGroup[] = [],
): Track[] {
  if (savedTracks && savedTracks.length > 0) {
    return cloneTracks(savedTracks);
  }
  return migrateLegacyClipsToTracks(clips, transitions, groups);
}

/**
 * Identity cache for {@link toLegacyTimelineView}.
 *
 * Stamping the derived placement fields necessarily allocates new clip objects,
 * so recomputing the view would hand the store's `useShallow` selectors fresh
 * element identities on every call and spin React into an update loop. Keying on
 * the *identity* of the three inputs makes repeated calls for the same editor
 * state — `useEditorTimelineClips`, `useEditorTotalDuration`, the timeline and
 * the preview all ask within one render — return the very same array. Zustand
 * replaces these arrays on every edit, so a stale entry is impossible.
 */
interface LegacyViewCacheEntry {
  tracks: Track[];
  clips: Clip[];
  groups: ClipGroup[];
  result: Clip[];
}

const LEGACY_VIEW_CACHE_SIZE = 4;
const legacyViewCache: LegacyViewCacheEntry[] = [];

function cachedLegacyView(
  tracks: Track[],
  clips: Clip[],
  groups: ClipGroup[],
): Clip[] | null {
  for (const entry of legacyViewCache) {
    if (entry.tracks !== tracks || entry.clips !== clips) continue;
    // Callers that omit `groups` get a fresh `[]` from the default parameter, so
    // compare "no groups" by emptiness rather than identity.
    const groupsMatch =
      entry.groups === groups || (entry.groups.length === 0 && groups.length === 0);
    if (groupsMatch) return entry.result;
  }
  return null;
}

function rememberLegacyView(
  tracks: Track[],
  clips: Clip[],
  groups: ClipGroup[],
  result: Clip[],
): Clip[] {
  legacyViewCache.unshift({ tracks, clips, groups, result });
  if (legacyViewCache.length > LEGACY_VIEW_CACHE_SIZE) legacyViewCache.length = LEGACY_VIEW_CACHE_SIZE;
  return result;
}

/**
 * Flatten track placements into the clip array that preview and FFmpeg export
 * consume (video tracks only).
 *
 * Stacking order and placement come from {@link buildVideoStack} — the single
 * source of truth — and are stamped onto each clip as the derived
 * `layerIndex` / `timelineStart` / `trackMuted` / `trackLocked` fields. Nothing
 * downstream re-derives them from clip properties, and nothing serializes them.
 */
export function toLegacyTimelineView(
  tracks: Track[],
  clips: Clip[],
  groups: ClipGroup[] = [],
): Clip[] {
  const cached = cachedLegacyView(tracks, clips, groups);
  if (cached) return cached;

  const timelineClips = getTimelineClips(clips, groups);
  const result = buildVideoStack(tracks, timelineClips).map((placement) =>
    withPlacement(placement.clip, placement),
  );
  return rememberLegacyView(tracks, clips, groups, result);
}

/**
 * Effective timeline clip order for preview/export when track placements exist.
 * Falls back to the flat clip list when tracks are empty.
 *
 * Lives here rather than in `timelineClips.ts` so that module stays a leaf
 * (this module imports `getTimelineClips` from it).
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

/** Ensure every timeline clip has a track placement. */
export function syncTracksWithClips(
  tracks: Track[],
  clips: Clip[],
  groups: ClipGroup[] = [],
): Track[] {
  const timelineClips = getTimelineClips(clips, groups);
  const placed = new Set(tracks.flatMap((t) => t.items.map((i) => i.clipId)));
  const unplaced = timelineClips.filter((c) => !placed.has(c.id));
  if (unplaced.length === 0) return tracks;

  const next = cloneTracks(tracks);
  const mainVideo =
    next.find((t) => t.id === MAIN_VIDEO_TRACK_ID && t.kind === 'video')
    ?? next.find((t) => t.kind === 'video');
  if (!mainVideo) return next;

  let cursor = computeTrackEnd(mainVideo, timelineClips);

  for (const clip of unplaced) {
    if (!isBaseClip(clip)) {
      const overlay =
        next.find((t) => t.id === OVERLAY_VIDEO_TRACK_ID)
        ?? next.find((t) => t.kind === 'video' && t.id !== mainVideo.id);
      if (overlay) {
        overlay.items.push({ clipId: clip.id, startTime: 0 });
        continue;
      }
    }
    mainVideo.items.push({ clipId: clip.id, startTime: cursor });
    cursor += getClipDuration(clip);
  }

  return next;
}

/** Append a clip to the appropriate default track. */
export function appendClipToTracks(
  tracks: Track[],
  clip: Clip,
  allClips: Clip[],
): Track[] {
  const next = cloneTracks(tracks);
  const targetId =
    clip.kind === 'audio' ? MAIN_AUDIO_TRACK_ID : MAIN_VIDEO_TRACK_ID;
  let track = next.find((t) => t.id === targetId);
  if (!track) {
    track = next.find((t) => t.kind === (clip.kind === 'audio' ? 'audio' : 'video'));
  }
  if (!track) return next;

  const end = computeTrackEnd(track, allClips);
  track.items.push({ clipId: clip.id, startTime: end });
  return next;
}

/**
 * Splice a clip into the lane right after another clip's out-point.
 *
 * This is a plain splice — it neither covers overlapping items nor shifts later
 * ones. The NLE overwrite / insert edits live in `editModes.ts`.
 */
export function insertClipOnTrackAfter(
  tracks: Track[],
  afterClipId: string,
  newClip: Clip,
  allClips: Clip[],
): Track[] {
  const located = findClipTrack(tracks, afterClipId);
  if (!located) {
    return appendClipToTracks(tracks, newClip, [...allClips, newClip]);
  }

  const next = cloneTracks(tracks);
  const track = next[located.trackIndex];
  const afterItem = track.items[located.itemIndex];
  const afterClip = clipById(allClips, afterClipId);
  const insertTime = afterItem.startTime + (afterClip ? getClipDuration(afterClip) : 0);

  track.items.splice(located.itemIndex + 1, 0, {
    clipId: newClip.id,
    startTime: insertTime,
  });

  return next;
}

/** Remove a clip from all tracks. */
export function removeClipFromTracks(tracks: Track[], clipId: string): Track[] {
  return tracks.map((track) => ({
    ...track,
    items: track.items.filter((item) => item.clipId !== clipId),
  }));
}

/** Replace one clip id with two after a split on the same track. */
export function replaceClipOnTrackAfterSplit(
  tracks: Track[],
  sourceClipId: string,
  leftId: string,
  rightId: string,
  rightStartTime: number,
): Track[] {
  const located = findClipTrack(tracks, sourceClipId);
  if (!located) return tracks;

  const next = cloneTracks(tracks);
  const track = next[located.trackIndex];
  const sourceItem = track.items[located.itemIndex];
  track.items.splice(
    located.itemIndex,
    1,
    { clipId: leftId, startTime: sourceItem.startTime },
    { clipId: rightId, startTime: rightStartTime },
  );
  return next;
}

/**
 * Move a clip item to another track at a new start time.
 *
 * Rejected (returns `tracks` unchanged) when the source or target lane is
 * locked, or when the clip's kind cannot live on the target lane — an audio
 * clip never lands on a video track and vice versa.
 */
export function moveClipBetweenTracks(
  tracks: Track[],
  clipId: string,
  targetTrackId: string,
  startTime: number,
  clips: Clip[] = [],
): Track[] {
  const target = tracks.find((t) => t.id === targetTrackId);
  if (!target || target.locked) return tracks;

  const source = findClipTrack(tracks, clipId);
  if (source?.track.locked) return tracks;

  const clip = clipById(clips, clipId);
  if (clip && !acceptsClipKind(target, clip.kind)) return tracks;

  const next = removeClipFromTracks(tracks, clipId).map(cloneTrack);
  const nextTarget = next.find((t) => t.id === targetTrackId);
  if (!nextTarget) return tracks;
  nextTarget.items.push({ clipId, startTime: Math.max(0, startTime) });
  nextTarget.items.sort((a, b) => a.startTime - b.startTime);
  return next;
}

/** Reorder clips on the main video track (legacy onReorder compatibility). */
export function reorderMainTrackClips(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
  fromIndex: number,
  insertBefore: number,
): Track[] {
  const legacy = toLegacyTimelineView(tracks, clips);
  const baseClips = legacy.filter(isBaseClip);
  if (fromIndex < 0 || fromIndex >= baseClips.length) return tracks;

  const reordered = [...baseClips];
  const [moved] = reordered.splice(fromIndex, 1);
  let target = insertBefore;
  if (fromIndex < insertBefore) target -= 1;
  target = Math.max(0, Math.min(target, reordered.length));
  reordered.splice(target, 0, moved);

  const mainTrack = tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)
    ?? tracks.find((t) => t.kind === 'video');
  if (!mainTrack) return tracks;

  const timelineIndices = reordered.map((_, i) => i);
  const segments = buildClipTimelineSegments(reordered, transitions, timelineIndices);

  const next = cloneTracks(tracks);
  const mt = next.find((t) => t.id === mainTrack.id);
  if (!mt) return tracks;

  mt.items = segments.map((seg) => ({
    clipId: seg.clip.id,
    startTime: seg.startTime,
  }));

  return next;
}

export interface TrackClipLayout {
  clip: Clip;
  trackId: string;
  trackIndex: number;
  itemIndex: number;
  startTime: number;
  duration: number;
  width: number;
  /** Pixel offset from timeline origin. */
  left: number;
}

/** Build per-track clip layouts for the multi-row timeline UI. */
export function buildTrackClipLayouts(
  tracks: Track[],
  clips: Clip[],
  groups: ClipGroup[],
  pixelsPerSecond: number,
): Map<string, TrackClipLayout[]> {
  const timelineClips = getTimelineClips(clips, groups);
  const clipMap = new Map(timelineClips.map((c) => [c.id, c]));
  const layouts = new Map<string, TrackClipLayout[]>();

  tracks.forEach((track, trackIndex) => {
    const row: TrackClipLayout[] = [];
    const sorted = [...track.items].sort((a, b) => a.startTime - b.startTime);
    for (let itemIndex = 0; itemIndex < sorted.length; itemIndex++) {
      const item = sorted[itemIndex];
      const clip = clipMap.get(item.clipId);
      if (!clip) continue;
      const duration = getClipDuration(clip);
      row.push({
        clip,
        trackId: track.id,
        trackIndex,
        itemIndex,
        startTime: item.startTime,
        duration,
        width: Math.max(duration * pixelsPerSecond, 24),
        left: item.startTime * pixelsPerSecond,
      });
    }
    layouts.set(track.id, row);
  });

  return layouts;
}

/** Total timeline duration (output) from track placements. */
export function computeTracksDuration(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
  groups: ClipGroup[] = [],
): number {
  const legacy = toLegacyTimelineView(tracks, clips, groups);
  const baseClips = legacy.filter(isBaseClip);
  if (baseClips.length > 0) {
    return computeTotalDuration(baseClips, transitions);
  }

  return tracks.reduce((max, track) => {
    const trackEnd = computeTrackEnd(track, clips);
    return Math.max(max, trackEnd);
  }, 0);
}

/** Collect concurrent audio-bed entries from dedicated audio tracks. */
export function getConcurrentAudioTrackItems(
  tracks: Track[],
): TrackItem[] {
  return audioTracks(tracks).flatMap((t) => t.items);
}

/**
 * Move a clip onto the video lane whose stacking index is `layerIndex`,
 * creating lanes as needed.
 *
 * Stacking order is track order (Phase B), so the Inspector's "layer" control
 * is a shortcut for "put this clip on video lane N" rather than an independent
 * compositing knob. Locked lanes block the move; `layerIndex` 0 targets the
 * base sequence and keeps the clip's existing start time when it has one.
 */
export function moveClipToVideoLayer(
  tracks: Track[],
  clipId: string,
  layerIndex: number,
  clips: Clip[] = [],
): Track[] {
  const target = Math.max(0, Math.round(layerIndex));
  const located = findClipTrack(tracks, clipId);
  const vTracks = videoTracks(tracks);
  const currentLayer = located ? vTracks.findIndex((t) => t.id === located.track.id) : -1;
  if (currentLayer === target) return tracks;
  if (located && located.track.kind !== 'video') return tracks;

  let next = tracks;
  while (videoTracks(next).length <= target) {
    next = addTrack(next, 'video');
  }

  const targetTrack = videoTracks(next)[target];
  const startTime = located
    ? located.track.items[located.itemIndex].startTime
    : computeTrackEnd(targetTrack, clips);

  return moveClipBetweenTracks(next, clipId, targetTrack.id, startTime, clips);
}
