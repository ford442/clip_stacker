import type { Clip, ClipGroup, ClipTransition, Track, TrackItem } from '../types';
import { createClipId } from './media';
import { getClipDuration } from './project';
import { buildClipTimelineSegments } from './previewComposition';
import { getTimelineClips } from './timelineClips';
import { computeTotalDuration } from './transitions';

/** Default row height for a timeline track lane (px). */
export const DEFAULT_TRACK_HEIGHT = 48;

/** Well-known track ids for the default project layout. */
export const MAIN_VIDEO_TRACK_ID = 'v1';
export const OVERLAY_VIDEO_TRACK_ID = 'v2';
export const MAIN_AUDIO_TRACK_ID = 'a1';

const DEFAULT_VIDEO_LABEL = 'Video';
const DEFAULT_AUDIO_LABEL = 'Audio';

function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

/** Default multi-track layout for new projects: main video, overlay video, audio bed. */
export function createDefaultTracks(): Track[] {
  return [
    {
      id: MAIN_VIDEO_TRACK_ID,
      kind: 'video',
      label: `${DEFAULT_VIDEO_LABEL} 1`,
      items: [],
      height: DEFAULT_TRACK_HEIGHT,
    },
    {
      id: OVERLAY_VIDEO_TRACK_ID,
      kind: 'video',
      label: `${DEFAULT_VIDEO_LABEL} 2`,
      items: [],
      height: DEFAULT_TRACK_HEIGHT,
    },
    {
      id: MAIN_AUDIO_TRACK_ID,
      kind: 'audio',
      label: `${DEFAULT_AUDIO_LABEL} 1`,
      items: [],
      height: DEFAULT_TRACK_HEIGHT,
    },
  ];
}

function cloneTrack(track: Track): Track {
  return {
    ...track,
    items: track.items.map((item) => ({ ...item })),
  };
}

export function cloneTracks(tracks: Track[]): Track[] {
  return tracks.map(cloneTrack);
}

/** Resolve a clip by id from the media pool. */
export function clipById(clips: Clip[], clipId: string): Clip | undefined {
  return clips.find((c) => c.id === clipId);
}

/** Return clips placed on a track in item order (not startTime order). */
export function getTrackClips(track: Track, clips: Clip[]): Clip[] {
  return track.items
    .map((item) => clipById(clips, item.clipId))
    .filter((c): c is Clip => c != null);
}

/** Find which track holds a clip (first match). */
export function findClipTrack(
  tracks: Track[],
  clipId: string,
): { track: Track; trackIndex: number; itemIndex: number } | null {
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    const itemIndex = track.items.findIndex((item) => item.clipId === clipId);
    if (itemIndex >= 0) {
      return { track, trackIndex, itemIndex };
    }
  }
  return null;
}

/** Video tracks in timeline order. */
export function videoTracks(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.kind === 'video');
}

/** Audio tracks in timeline order. */
export function audioTracks(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.kind === 'audio');
}

function computeTrackEnd(track: Track, clips: Clip[]): number {
  const clipMap = new Map(clips.map((c) => [c.id, c]));
  return track.items.reduce((max, item) => {
    const c = clipMap.get(item.clipId);
    const dur = c ? getClipDuration(c) : 0;
    return Math.max(max, item.startTime + dur);
  }, 0);
}

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
 * Flatten track placements back into the legacy clip array + layerIndex values
 * expected by preview and FFmpeg export (video tracks only).
 */
export function toLegacyTimelineView(
  tracks: Track[],
  clips: Clip[],
  groups: ClipGroup[] = [],
): Clip[] {
  const timelineClips = getTimelineClips(clips, groups);
  const clipMap = new Map(timelineClips.map((c) => [c.id, c]));
  const result: Clip[] = [];

  const vTracks = videoTracks(tracks);
  for (let vi = 0; vi < vTracks.length; vi++) {
    const track = vTracks[vi];
    const sorted = [...track.items].sort((a, b) => a.startTime - b.startTime);
    for (const item of sorted) {
      const clip = clipMap.get(item.clipId);
      if (!clip) continue;
      const layerIndex = vi === 0 ? 0 : vi;
      result.push({ ...clip, layerIndex });
    }
  }

  return result;
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

/** Insert a clip after another clip on the same track (overwrite edit mode). */
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

/** Move a clip item to another track at a new start time. */
export function moveClipBetweenTracks(
  tracks: Track[],
  clipId: string,
  targetTrackId: string,
  startTime: number,
): Track[] {
  const next = removeClipFromTracks(tracks, clipId).map(cloneTrack);
  const target = next.find((t) => t.id === targetTrackId);
  if (!target) return tracks;
  target.items.push({ clipId, startTime });
  target.items.sort((a, b) => a.startTime - b.startTime);
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
