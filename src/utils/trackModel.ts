import type { Clip, ClipGroup, ClipTransition, Track, TrackItem, TrackKind } from '../types';
import { createClipId } from './media';
import { getClipDuration } from './project';
import { buildClipTimelineSegments } from './previewComposition';
import { getTimelineClips } from './timelineClips';
import { buildVideoStack, withPlacement } from './trackStacking';
import { computeTotalDuration } from './transitions';

/** Default row height for a timeline track lane (px). */
export const DEFAULT_TRACK_HEIGHT = 48;
/** Lane row height bounds for the header's drag-to-resize handle. */
export const MIN_TRACK_HEIGHT = 28;
export const MAX_TRACK_HEIGHT = 160;

/** Well-known track ids for the default project layout. */
export const MAIN_VIDEO_TRACK_ID = 'v1';
export const OVERLAY_VIDEO_TRACK_ID = 'v2';
export const MAIN_AUDIO_TRACK_ID = 'a1';

const DEFAULT_VIDEO_LABEL = 'Video';
const DEFAULT_AUDIO_LABEL = 'Audio';
const DEFAULT_TEXT_LABEL = 'Titles';

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

// ─── Lane chrome (Phase A) ───────────────────────────────────────────────────

/** Whether a clip of `kind` may be placed on `track`. */
export function acceptsClipKind(track: Track, kind: Clip['kind']): boolean {
  if (track.kind === 'text') return false;
  return track.kind === 'audio' ? kind === 'audio' : kind !== 'audio';
}

/** The track holding `clipId`, or null when it has no placement. */
export function trackForClip(tracks: Track[], clipId: string): Track | null {
  return findClipTrack(tracks, clipId)?.track ?? null;
}

/**
 * True when `clipId` sits on a locked lane. Trim, drag, split and delete all
 * consult this before mutating, so a locked lane is inert from every entry
 * point (mouse, keyboard, inspector).
 */
export function isClipLocked(tracks: Track[], clipId: string): boolean {
  return Boolean(trackForClip(tracks, clipId)?.locked);
}

/** Default label for the next lane of `kind` (`Video 3`, `Audio 2`, `Titles 1`). */
export function nextTrackLabel(tracks: Track[], kind: TrackKind): string {
  const base =
    kind === 'audio'
      ? DEFAULT_AUDIO_LABEL
      : kind === 'text'
        ? DEFAULT_TEXT_LABEL
        : DEFAULT_VIDEO_LABEL;
  const count = tracks.filter((t) => t.kind === kind).length;
  return `${base} ${count + 1}`;
}

/**
 * Append a new empty lane of `kind`.
 *
 * Video lanes are inserted after the last existing video lane so stacking order
 * stays "video tracks first, bottom-up" — `buildVideoStack` reads the array
 * order, so appending a video lane at the very end would still work, but
 * keeping the kinds grouped matches how the timeline renders them.
 */
export function addTrack(tracks: Track[], kind: TrackKind): Track[] {
  const track: Track = {
    id: createClipId(),
    kind,
    label: nextTrackLabel(tracks, kind),
    items: [],
    height: DEFAULT_TRACK_HEIGHT,
  };

  if (kind !== 'video') return [...cloneTracks(tracks), track];

  const next = cloneTracks(tracks);
  let insertAt = next.length;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].kind === 'video') {
      insertAt = i + 1;
      break;
    }
  }
  next.splice(insertAt, 0, track);
  return next;
}

/**
 * Remove a lane. The main video lane and the last remaining video lane are kept
 * (the base sequence has nowhere else to live), as are locked lanes.
 */
export function removeTrack(tracks: Track[], trackId: string): Track[] {
  const track = tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return tracks;
  if (track.id === MAIN_VIDEO_TRACK_ID) return tracks;
  if (track.kind === 'video' && videoTracks(tracks).length <= 1) return tracks;
  return cloneTracks(tracks).filter((t) => t.id !== trackId);
}

/** Whether a lane can be removed (drives the lane header's × button). */
export function canRemoveTrack(tracks: Track[], trackId: string): boolean {
  return removeTrack(tracks, trackId) !== tracks;
}

function patchTrack(
  tracks: Track[],
  trackId: string,
  patch: (track: Track) => Track,
): Track[] {
  let changed = false;
  const next = tracks.map((track) => {
    if (track.id !== trackId) return track;
    changed = true;
    return patch(cloneTrack(track));
  });
  return changed ? next : tracks;
}

/** Set (or clear) a lane's mute flag. Muted lanes are dropped from the mix. */
export function setTrackMuted(
  tracks: Track[],
  trackId: string,
  muted: boolean,
): Track[] {
  return patchTrack(tracks, trackId, (track) => {
    if (muted) return { ...track, muted: true };
    const next = { ...track };
    delete next.muted;
    return next;
  });
}

/** Set (or clear) a lane's lock flag. Locked lanes reject every edit. */
export function setTrackLocked(
  tracks: Track[],
  trackId: string,
  locked: boolean,
): Track[] {
  return patchTrack(tracks, trackId, (track) => {
    if (locked) return { ...track, locked: true };
    const next = { ...track };
    delete next.locked;
    return next;
  });
}

/** Lane row height in px, clamped to a usable range. */
export function setTrackHeight(
  tracks: Track[],
  trackId: string,
  height: number,
): Track[] {
  const clamped = Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(height)));
  return patchTrack(tracks, trackId, (track) => ({ ...track, height: clamped }));
}

/** Rename a lane. An empty label falls back to the kind's default. */
export function renameTrack(
  tracks: Track[],
  trackId: string,
  label: string,
): Track[] {
  const trimmed = label.trim();
  return patchTrack(tracks, trackId, (track) => ({
    ...track,
    label: trimmed || nextTrackLabel([], track.kind),
  }));
}

// ─── Text / titles tracks (Phase C) ─────────────────────────────────────────

/**
 * Ids of the text-overlay placements on `text` lanes, in lane order.
 *
 * A `text` lane's `TrackItem.clipId` holds a {@link TextOverlay} id (see the
 * type docs) so titles participate in lane mute / lock / reorder without a
 * second timeline schema. Time-coded captions stay on their own caption track —
 * see AGENTS.md.
 */
export function textTrackOverlayIds(tracks: Track[]): string[] {
  return tracks.filter((t) => t.kind === 'text').flatMap((t) => t.items.map((i) => i.clipId));
}

/**
 * Text overlays that should be drawn: every overlay not placed on a muted text
 * lane. Overlays with no lane placement are always visible, so projects that
 * never created a titles lane behave exactly as before.
 */
export function visibleTextOverlays<T extends { id: string }>(
  tracks: Track[],
  overlays: T[],
): T[] {
  const hidden = new Set(
    tracks
      .filter((t) => t.kind === 'text' && t.muted)
      .flatMap((t) => t.items.map((i) => i.clipId)),
  );
  if (hidden.size === 0) return overlays;
  return overlays.filter((overlay) => !hidden.has(overlay.id));
}

/** Whether a text overlay sits on a locked titles lane. */
export function isTextOverlayLocked(tracks: Track[], overlayId: string): boolean {
  return tracks.some(
    (t) => t.kind === 'text' && t.locked && t.items.some((i) => i.clipId === overlayId),
  );
}

/** Place a text overlay on a titles lane at an output time. */
export function placeTextOverlayOnTrack(
  tracks: Track[],
  overlayId: string,
  trackId: string,
  startTime: number,
): Track[] {
  const target = tracks.find((t) => t.id === trackId);
  if (!target || target.kind !== 'text' || target.locked) return tracks;
  const next = cloneTracks(tracks).map((track) =>
    track.kind === 'text'
      ? { ...track, items: track.items.filter((i) => i.clipId !== overlayId) }
      : track,
  );
  const nextTarget = next.find((t) => t.id === trackId)!;
  nextTarget.items.push({ clipId: overlayId, startTime: Math.max(0, startTime) });
  nextTarget.items.sort((a, b) => a.startTime - b.startTime);
  return next;
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

/** Drop a text overlay's placement from every titles lane (overlay deleted). */
export function removeTextOverlayFromTracks(
  tracks: Track[],
  overlayId: string,
): Track[] {
  if (!tracks.some((t) => t.kind === 'text' && t.items.some((i) => i.clipId === overlayId))) {
    return tracks;
  }
  return tracks.map((track) =>
    track.kind === 'text'
      ? { ...track, items: track.items.filter((i) => i.clipId !== overlayId) }
      : track,
  );
}
