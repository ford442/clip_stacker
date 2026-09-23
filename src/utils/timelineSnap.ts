import type { CaptionEntry, Clip, MasterAudio, SyncMarker, Track } from '../types';
import { beatsInTrimWindow } from './beatMarkers';
import { DEFAULT_BEAT_SNAP_THRESHOLD_MS, snapTimeToBeat } from './beatSnap';
import { getClipPlaybackRate } from './playbackRate';
import { getClipDuration } from './project/clipHelpers';

/**
 * Timeline magnet (#168 follow-up): snap an output time to the playhead, clip
 * edges, markers, caption edges or beats.
 *
 * Reuses {@link snapTimeToBeat} for the nearest-within-threshold search and the
 * beat-snap tolerance as the default threshold. When two candidates are equally
 * close the earlier kind in {@link SNAP_PRIORITY} wins — the playhead beats a
 * clip edge, which beats a beat.
 */

export type SnapTargetKind = 'playhead' | 'edge' | 'marker' | 'caption' | 'beat';

/** Candidate output times, grouped by kind. */
export interface SnapTargets {
  playhead?: number | null;
  itemEdges?: number[];
  markers?: number[];
  captions?: number[];
  beats?: number[];
}

export interface SnapResult {
  /** The (possibly snapped) time. */
  time: number;
  /** What it snapped to, or undefined when nothing was in range. */
  kind?: SnapTargetKind;
}

export const SNAP_PRIORITY: SnapTargetKind[] = ['playhead', 'edge', 'marker', 'caption', 'beat'];

/** Default magnet radius in seconds (the beat-snap tolerance). */
export const DEFAULT_SNAP_THRESHOLD_SEC = DEFAULT_BEAT_SNAP_THRESHOLD_MS / 1000;

/** Magnet radius for a zoom level: at least `px` on screen, never below the default. */
export function snapThresholdForZoom(pixelsPerSecond: number, px = 8): number {
  if (!(pixelsPerSecond > 0)) return DEFAULT_SNAP_THRESHOLD_SEC;
  return Math.max(DEFAULT_SNAP_THRESHOLD_SEC, px / pixelsPerSecond);
}

function listFor(targets: SnapTargets, kind: SnapTargetKind): number[] {
  switch (kind) {
    case 'playhead':
      return targets.playhead != null && Number.isFinite(targets.playhead) ? [targets.playhead] : [];
    case 'edge':
      return targets.itemEdges ?? [];
    case 'marker':
      return targets.markers ?? [];
    case 'caption':
      return targets.captions ?? [];
    case 'beat':
      return targets.beats ?? [];
  }
}

/** Snap `time` to the nearest target within `thresholdSec`. */
export function snapTimelineTime(
  time: number,
  targets: SnapTargets,
  thresholdSec = DEFAULT_SNAP_THRESHOLD_SEC,
): SnapResult {
  let best: SnapResult = { time };
  let bestDist = Infinity;
  for (const kind of SNAP_PRIORITY) {
    const hit = snapTimeToBeat(time, listFor(targets, kind), thresholdSec * 1000);
    if (hit == null) continue;
    const dist = Math.abs(hit - time);
    // Strictly closer wins; ties keep the higher-priority kind found first.
    if (dist < bestDist - 1e-9) {
      best = { time: hit, kind };
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Snap a clip being placed at `start` for `duration` seconds: whichever of its
 * two edges lands closer to a target wins, and the start moves to match.
 */
export function snapClipStart(
  start: number,
  duration: number,
  targets: SnapTargets,
  thresholdSec = DEFAULT_SNAP_THRESHOLD_SEC,
): SnapResult {
  const head = snapTimelineTime(start, targets, thresholdSec);
  const tail = snapTimelineTime(start + duration, targets, thresholdSec);
  const headDist = head.kind ? Math.abs(head.time - start) : Infinity;
  const tailDist = tail.kind ? Math.abs(tail.time - (start + duration)) : Infinity;
  if (headDist === Infinity && tailDist === Infinity) return { time: start };
  if (tailDist < headDist) {
    return { time: Math.max(0, tail.time - duration), kind: tail.kind };
  }
  return { time: Math.max(0, head.time), kind: head.kind };
}

export interface CollectSnapTargetsInput {
  tracks: Track[];
  clips: Clip[];
  playhead?: number | null;
  captions?: CaptionEntry[];
  markers?: SyncMarker[];
  masterAudio?: MasterAudio | null;
  /** The clip being moved — its own edges and beats are not targets. */
  excludeClipId?: string | null;
}

/** Gather every snap target from the editor state (output-timeline seconds). */
export function collectSnapTargets({
  tracks,
  clips,
  playhead,
  captions = [],
  markers = [],
  masterAudio,
  excludeClipId,
}: CollectSnapTargetsInput): SnapTargets {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const itemEdges: number[] = [];
  const beats: number[] = [];

  for (const track of tracks) {
    if (track.kind === 'text') continue;
    for (const item of track.items) {
      if (item.clipId === excludeClipId) continue;
      const clip = byId.get(item.clipId);
      if (!clip) continue;
      itemEdges.push(item.startTime, item.startTime + getClipDuration(clip));
      const rate = getClipPlaybackRate(clip);
      for (const beat of beatsInTrimWindow(clip)) {
        beats.push(item.startTime + (beat - clip.trimStart) / rate);
      }
    }
  }

  if (masterAudio?.beatTimestamps?.length) {
    for (const beat of masterAudio.beatTimestamps) beats.push(masterAudio.startTime + beat);
  }

  return {
    playhead: playhead ?? null,
    itemEdges,
    markers: markers.map((m) => m.time),
    captions: captions.flatMap((c) => [c.startSec, c.endSec]),
    beats,
  };
}
