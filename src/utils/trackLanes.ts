import type { Clip, Track, TrackKind } from '../types';
import { createClipId } from './media';
import {
  cloneTrack,
  cloneTracks,
  DEFAULT_AUDIO_LABEL,
  DEFAULT_TEXT_LABEL,
  DEFAULT_TRACK_HEIGHT,
  DEFAULT_VIDEO_LABEL,
  findClipTrack,
  MAIN_VIDEO_TRACK_ID,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  videoTracks,
} from './trackBasics';

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
