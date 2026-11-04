/**
 * Track ids, defaults and lookups shared by the track model modules. Public
 * names are re-exported from `trackModel.ts`, the entry point for track edits.
 */

import type { Clip, Track } from '../types';
import { getClipDuration } from './clipTiming';

/** Default row height for a timeline track lane (px). */
export const DEFAULT_TRACK_HEIGHT = 48;
/** Lane row height bounds for the header's drag-to-resize handle. */
export const MIN_TRACK_HEIGHT = 28;
export const MAX_TRACK_HEIGHT = 160;

/** Well-known track ids for the default project layout. */
export const MAIN_VIDEO_TRACK_ID = 'v1';
export const OVERLAY_VIDEO_TRACK_ID = 'v2';
export const MAIN_AUDIO_TRACK_ID = 'a1';

export const DEFAULT_VIDEO_LABEL = 'Video';
export const DEFAULT_AUDIO_LABEL = 'Audio';
export const DEFAULT_TEXT_LABEL = 'Titles';

export function isBaseClip(clip: Clip): boolean {
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

export function cloneTrack(track: Track): Track {
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

export function computeTrackEnd(track: Track, clips: Clip[]): number {
  const clipMap = new Map(clips.map((c) => [c.id, c]));
  return track.items.reduce((max, item) => {
    const c = clipMap.get(item.clipId);
    const dur = c ? getClipDuration(c) : 0;
    return Math.max(max, item.startTime + dur);
  }, 0);
}
