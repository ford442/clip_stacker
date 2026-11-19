/**
 * Offline clips: clips whose media is not loaded (`Clip.offline`).
 *
 * An imported timeline names a file the library does not have, or a saved
 * project's media is gone (#279: an evicted blob). The clip keeps its place,
 * trims and settings; preview draws a slate (`media/offlineSlate.ts`), audio
 * skips it, export refuses while one sits on an unmuted lane, and
 * *Relink media…* swaps a file in through one `commitEdit`.
 */

import type { Clip, ClipOffline, SerializedClip, Track } from '../types';
import { MIN_CLIP_DURATION } from '../media/media';

/** The MIME type of an offline clip's placeholder `File` (it holds no bytes). */
export const OFFLINE_FILE_TYPE = 'application/x-clip-stacker-offline';

export function isOfflineClip(clip: Pick<Clip, 'offline'> | null | undefined): boolean {
  return Boolean(clip?.offline);
}

/** The offline record a saved clip carries, or one built from its file name. */
export function offlineRecordFor(saved: Pick<SerializedClip, 'fileName' | 'offline'>, extra: Partial<ClipOffline> = {}): ClipOffline {
  const base = saved.offline ?? { fileName: saved.fileName };
  const record: ClipOffline = { fileName: base.fileName || saved.fileName };
  const url = extra.url ?? base.url;
  const hash = extra.hash ?? base.hash;
  const driveId = extra.driveId ?? base.driveId;
  if (url) record.url = url;
  if (hash) record.hash = hash;
  if (driveId) record.driveId = driveId;
  return record;
}

/**
 * A live clip with no media for a saved clip. The caller applies the saved
 * clip's settings over it, as for any loaded clip.
 */
export function createOfflineClip(saved: SerializedClip, extra: Partial<ClipOffline> = {}): Clip {
  const offline = offlineRecordFor(saved, extra);
  const duration = Number(saved.duration);
  return {
    id: saved.id,
    file: new File([], offline.fileName || 'offline', { type: OFFLINE_FILE_TYPE }),
    objectUrl: '',
    title: saved.title || offline.fileName,
    kind: saved.kind === 'audio' ? 'audio' : 'video',
    duration: Math.max(MIN_CLIP_DURATION, Number.isFinite(duration) ? duration : MIN_CLIP_DURATION),
    ...(saved.videoWidth ? { videoWidth: saved.videoWidth } : {}),
    ...(saved.videoHeight ? { videoHeight: saved.videoHeight } : {}),
    ...(saved.hasAudio === false || saved.hasAudio === true ? { hasAudio: saved.hasAudio } : {}),
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    offline,
  };
}

/** Offline clips placed on a lane that is not muted (what blocks an export). */
export function offlineClipsOnUnmutedLanes(tracks: Track[], clips: Clip[]): Clip[] {
  const offline = new Map(clips.filter(isOfflineClip).map((clip) => [clip.id, clip]));
  if (offline.size === 0) return [];
  const found = new Map<string, Clip>();
  for (const track of tracks) {
    if (track.kind === 'text' || track.muted) continue;
    for (const item of track.items) {
      const clip = offline.get(item.clipId);
      if (clip) found.set(clip.id, clip);
    }
  }
  return [...found.values()];
}

/**
 * Offline clips that would render: on unmuted lanes of this timeline and,
 * through `timelineClips`' derived `nested` contents, of every nested
 * sequence it plays.
 */
export function blockingOfflineClips(tracks: Track[], clips: Clip[], timelineClips: Clip[] = [], depth = 0): Clip[] {
  const found = offlineClipsOnUnmutedLanes(tracks, clips);
  if (depth >= 8) return found;
  for (const clip of timelineClips) {
    const nested = clip.nested;
    if (!nested || clip.trackMuted) continue;
    found.push(...blockingOfflineClips(nested.tracks, nested.clips, nested.clips, depth + 1));
  }
  return [...new Map(found.map((clip) => [clip.id, clip])).values()];
}

/** The refusal an export gives while offline clips are active, or null. */
export function offlineExportRefusal(tracks: Track[], clips: Clip[], timelineClips: Clip[] = []): string | null {
  const blocking = blockingOfflineClips(tracks, clips, timelineClips);
  if (blocking.length === 0) return null;
  const names = blocking.slice(0, 3).map((clip) => clip.offline?.fileName ?? clip.title);
  const more = blocking.length > 3 ? ` and ${blocking.length - 3} more` : '';
  return `${blocking.length} offline clip${blocking.length === 1 ? '' : 's'} (${names.join(', ')}${more}) — relink the media (File → Relink media…), delete them, or mute their lanes before rendering.`;
}

/** What relinking takes from the media it found. */
export interface RelinkedMedia {
  file: File;
  objectUrl: string;
  duration: number;
  videoWidth?: number | undefined;
  videoHeight?: number | undefined;
  hasAudio?: boolean | undefined;
}

/**
 * The clip with `media` swapped in: trims and settings stay, the offline
 * record goes. A trim past the new media's end is clamped to it.
 */
export function relinkClip(clip: Clip, media: RelinkedMedia): Clip {
  const { offline: _offline, ...rest } = clip;
  const duration = Math.max(MIN_CLIP_DURATION, media.duration);
  const trimStart = Math.min(clip.trimStart, Math.max(0, duration - MIN_CLIP_DURATION));
  const trimEnd = Number.isFinite(clip.trimEnd) ? Math.min(clip.trimEnd, duration) : clip.trimEnd;
  const next: Clip = {
    ...rest,
    file: media.file,
    objectUrl: media.objectUrl,
    duration,
    trimStart,
    trimEnd: Number.isFinite(trimEnd) && trimEnd <= trimStart ? NaN : trimEnd,
  };
  if (media.videoWidth !== undefined) next.videoWidth = media.videoWidth;
  if (media.videoHeight !== undefined) next.videoHeight = media.videoHeight;
  if (media.hasAudio !== undefined) next.hasAudio = media.hasAudio;
  return next;
}
