/**
 * The neutral timeline every interchange format reads and writes.
 *
 * `mapping.ts` is the only place a Clip Stacker project becomes one of these
 * (and back); `otio.ts`, `fcpxml.ts` and `edl.ts` only translate this model to
 * and from text. So the three formats cannot drift: a mapping rule changes in
 * one place.
 *
 * All times are integer frames at the timeline's `rate`. Record positions are
 * implicit in item order (gaps are explicit), as in OTIO; transitions sit
 * between two items and borrow `inOffset` frames before the cut and
 * `outOffset` after it from the clips' handles.
 *
 * `meta` is the `clip_stacker` namespace: what Clip Stacker needs back that
 * the format has no element for (finishing, bus FX, keys, ids, exact seconds).
 * A foreign tool carries it through untouched or drops it; the importer only
 * trusts it where it still agrees with the format's own values.
 */

import type { TimecodeRate } from './timecode';

/** The metadata namespace key (OTIO `metadata.clip_stacker`, FCPXML `md` keys). */
export const CLIP_STACKER_NAMESPACE = 'clip_stacker';

export type MetaBag = Record<string, unknown>;

export interface MediaReference {
  /** File name: the key media relinking starts from. */
  name: string;
  /** Where the file was, as written (a relative name, `file://` URL or `https` URL). */
  url?: string;
  /** Length of the media at the timeline rate (OTIO `available_range`, FCPXML asset duration). */
  availableFrames?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  /** `fingerprintMedia` hash, when the exporter knew it. */
  hash?: string;
  /** Google Drive file id, when the clip came from Drive. */
  driveId?: string;
}

export interface InterchangeMarker {
  /** Frame on the timeline (or clip-local for clip markers). */
  frame: number;
  duration: number;
  name: string;
  meta?: MetaBag;
}

export interface InterchangeClip {
  type: 'clip';
  name: string;
  media: MediaReference;
  /** First media frame shown (media time at the timeline rate). */
  sourceIn: number;
  /** Frames the clip occupies on its track. */
  duration: number;
  /** Constant speed (1 = normal). Media frames consumed = duration × speed. */
  speed: number;
  /**
   * Speed automation as a time map: record-frame offset within the clip →
   * media frame. Present only for a ramped clip; `speed` is then the average.
   */
  timeMap?: Array<{ at: number; source: number }>;
  enabled: boolean;
  /** Static gain in dB and its keyframes (record-frame offsets), when not unity. */
  volume?: { db: number; keys: Array<{ at: number; db: number }> };
  meta?: MetaBag;
}

/** A nested sequence placed as one item (OTIO `Stack`, FCPXML `ref-clip`). */
export interface InterchangeStack {
  type: 'stack';
  name: string;
  /** First frame of the nested timeline shown, and frames on the track. */
  sourceIn: number;
  duration: number;
  enabled: boolean;
  tracks: InterchangeTrack[];
  /** Frames the nested timeline runs. */
  length: number;
  meta?: MetaBag;
}

export interface InterchangeGap {
  type: 'gap';
  duration: number;
}

export interface InterchangeTransition {
  type: 'transition';
  /** Clip Stacker transition id (`dissolve`, `wipeleft`, …). */
  name: string;
  /** Frames before the cut, taken from the outgoing clip's tail handle. */
  inOffset: number;
  /** Frames after the cut, taken from the incoming clip's head handle. */
  outOffset: number;
  meta?: MetaBag;
}

/** A title (text overlay) on a titles track. */
export interface InterchangeTitle {
  type: 'title';
  text: string;
  duration: number;
  enabled: boolean;
  meta?: MetaBag;
}

export type InterchangeItem =
  | InterchangeClip
  | InterchangeStack
  | InterchangeGap
  | InterchangeTransition
  | InterchangeTitle;

/**
 * Track roles. `base` is the first video lane (the sequence transitions
 * live on); `overlay` the video lanes above it; `titles` a titles lane
 * (a video track of title items); `audio` an audio lane.
 */
export type InterchangeTrackRole = 'base' | 'overlay' | 'titles' | 'audio';

export interface InterchangeTrack {
  kind: 'video' | 'audio';
  role: InterchangeTrackRole;
  name: string;
  enabled: boolean;
  items: InterchangeItem[];
  meta?: MetaBag;
}

export interface InterchangeCaption {
  frame: number;
  duration: number;
  text: string;
  meta?: MetaBag;
}

export interface InterchangeTimeline {
  name: string;
  rate: TimecodeRate;
  /** Timecode of frame 0, as a frame count at `rate`. */
  startFrame: number;
  width: number;
  height: number;
  /** Bottom to top: base video, overlays, titles, then audio tracks. */
  tracks: InterchangeTrack[];
  markers: InterchangeMarker[];
  captions: InterchangeCaption[];
  meta?: MetaBag;
}

/** Frames a track runs: the sum of its items (transitions take no track time). */
export function trackLength(track: Pick<InterchangeTrack, 'items'>): number {
  let frames = 0;
  for (const item of track.items) if (item.type !== 'transition') frames += item.duration;
  return frames;
}

/** Frames the timeline runs: its longest track. */
export function timelineLength(tracks: InterchangeTrack[]): number {
  return tracks.reduce((max, track) => Math.max(max, trackLength(track)), 0);
}

/** Each non-transition item with its record start frame on its track. */
export function placedItems(track: Pick<InterchangeTrack, 'items'>): Array<{ item: InterchangeItem; start: number; index: number }> {
  const out: Array<{ item: InterchangeItem; start: number; index: number }> = [];
  let at = 0;
  track.items.forEach((item, index) => {
    if (item.type === 'transition') {
      out.push({ item, start: at, index });
      return;
    }
    out.push({ item, start: at, index });
    at += item.duration;
  });
  return out;
}
