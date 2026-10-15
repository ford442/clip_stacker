/**
 * Shared state, result helpers, base-lane maths and ripple for the NLE edits.
 * `editModes.ts` is the entry point and documents the conventions.
 */

import type { Clip, ClipTransition, Track, TrackItem } from '../types';
import { MIN_CLIP_DURATION } from './media';
// Submodule imports (not the `./project` / `./previewComposition` barrels) keep
// this file out of the trackModel ↔ project import cycle — see trackStacking.ts.
import { getClipDuration } from './clipTiming';
import { buildClipTimelineSegments, isActiveTransition } from './previewCompositionSegments';
import { getClipLoopCount, getClipPlaybackRate } from './playbackRate';
import { clipHasRateAutomation } from './timeRemap';
import { findClipTrack, videoTracks } from './trackModel';

/** The editable slices an edit may change. */
export interface EditState {
  tracks: Track[];
  clips: Clip[];
  transitions: ClipTransition[];
}

export type EditResult =
  | { ok: true; state: EditState }
  | { ok: false; reason: string };

/** Sticky timeline tool — what a nudge / edge drag on the selected clip does. */
export type TimelineEditTool = 'select' | 'ripple' | 'roll' | 'slip' | 'slide';

/** What a drop onto a lane does to the items already there. */
export type DropEditMode = 'overwrite' | 'insert';

export interface RippleOptions {
  /** Also shift items on every other lane (sync-lock). Default lane-local. */
  linked?: boolean;
}

/** Positions closer than this are treated as touching (float drift). */
export const EPS = 1e-4;

export function fail(reason: string): EditResult {
  return { ok: false, reason };
}

function done(state: EditState): EditResult {
  return { ok: true, state };
}

export function laneLabel(track: Track): string {
  return track.label ?? track.id;
}

export function lockedReason(track: Track): string {
  return `${laneLabel(track)} is locked — unlock the lane to edit it.`;
}

/** True when `trackId` is the base sequence (first video lane). */
export function isBaseLane(tracks: Track[], trackId: string): boolean {
  return videoTracks(tracks)[0]?.id === trackId;
}

export function sortedItems(track: Track): TrackItem[] {
  return [...track.items].sort((a, b) => a.startTime - b.startTime);
}

export function clipMap(clips: Clip[]): Map<string, Clip> {
  return new Map(clips.map((c) => [c.id, c]));
}

function sourceEnd(clip: Clip): number {
  return Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
}

/** Why a clip's trim window cannot be moved by an output-time delta, if at all. */
export function untrimmableReason(clip: Clip): string | null {
  if (clipHasRateAutomation(clip)) {
    return `"${clip.title}" has a speed ramp — edit its trims in the Inspector.`;
  }
  if (getClipLoopCount(clip) > 1) {
    return `"${clip.title}" loops — edit its trims in the Inspector.`;
  }
  return null;
}

/**
 * Move a clip's in- and out-points by output-time deltas (positive = later in
 * the source). Returns null when the window would leave the source media or
 * shrink below {@link MIN_CLIP_DURATION}.
 */
export function shiftClipTrim(clip: Clip, inDelta: number, outDelta: number): Clip | null {
  if (untrimmableReason(clip)) return null;
  const rate = getClipPlaybackRate(clip);
  const start = clip.trimStart + inDelta * rate;
  const end = sourceEnd(clip) + outDelta * rate;
  if (start < -EPS || end > clip.duration + EPS) return null;
  if ((end - start) / rate < MIN_CLIP_DURATION - EPS) return null;
  const trimStart = Math.max(0, start);
  const trimEnd = Math.min(clip.duration, end);
  return {
    ...clip,
    trimStart,
    // Keep the "full duration" sentinel when the out-point lands on the source end.
    trimEnd:
      !Number.isFinite(clip.trimEnd) && Math.abs(trimEnd - clip.duration) < EPS
        ? clip.trimEnd
        : trimEnd,
  };
}

export function replaceClips(clips: Clip[], updates: Map<string, Clip>): Clip[] {
  if (updates.size === 0) return clips;
  return clips.map((c) => updates.get(c.id) ?? c);
}

/** Transition-in duration for base-lane slot `index` (0 when none). */
function transitionAt(transitions: ClipTransition[], index: number): number {
  const t = transitions.find((x) => x.afterClipIndex === index);
  return isActiveTransition(t) ? t.duration : 0;
}

/** Clip ids on the base lane, in play order. */
export function baseLaneOrder(tracks: Track[]): string[] {
  const base = videoTracks(tracks)[0];
  return base ? sortedItems(base).map((i) => i.clipId) : [];
}

/**
 * Rewrite the base lane's start times from transition-aware segment math.
 * Item order is preserved; gaps and overlaps collapse into the edit list.
 */
export function normalizeBaseLane(
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
): Track[] {
  const base = videoTracks(tracks)[0];
  if (!base) return tracks;
  const byId = clipMap(clips);
  const ordered = sortedItems(base).filter((item) => byId.has(item.clipId));
  const segClips = ordered.map((item) => byId.get(item.clipId)!);
  const segments = buildClipTimelineSegments(
    segClips,
    transitions,
    segClips.map((_, i) => i),
  );
  const items = segments.map((seg) => ({ clipId: seg.clip.id, startTime: seg.startTime }));
  return tracks.map((t) => (t.id === base.id ? { ...t, items } : t));
}

/**
 * Re-key base-lane transitions after the lane's clip order changed. A
 * transition survives only while the two clips it joined are still adjacent;
 * `alias` maps a split-off tail piece back to the clip it was cut from, so an
 * xfade out of a clip that was split by an overwrite follows the tail.
 */
export function remapBaseTransitions(
  prevOrder: string[],
  nextOrder: string[],
  transitions: ClipTransition[],
  alias: Map<string, string> = new Map(),
): ClipTransition[] {
  const resolve = (id: string) => alias.get(id) ?? id;
  const result: ClipTransition[] = [];
  for (const t of transitions) {
    const i = t.afterClipIndex;
    if (i < 1 || i >= prevOrder.length) {
      // Out of range for the lane (stale slot) — leave it untouched.
      result.push(t);
      continue;
    }
    const incoming = prevOrder[i];
    const outgoing = prevOrder[i - 1];
    const j = nextOrder.indexOf(incoming);
    if (j >= 1 && resolve(nextOrder[j - 1]) === outgoing) {
      result.push(j === i ? t : { ...t, afterClipIndex: j });
    }
  }
  return result;
}

/**
 * Durations must stay longer than the xfades on either side of a base clip.
 * Only clips this edit touched (new trims or a new slot) are checked, so a
 * pre-existing problem elsewhere never blocks an unrelated edit.
 */
function baseDurationsValid(
  prev: EditState,
  tracks: Track[],
  clips: Clip[],
  transitions: ClipTransition[],
): boolean {
  const byId = clipMap(clips);
  const prevById = clipMap(prev.clips);
  const prevOrder = baseLaneOrder(prev.tracks);
  return baseLaneOrder(tracks).every((id, index) => {
    const clip = byId.get(id);
    if (!clip) return true;
    if (prevById.get(id) === clip && prevOrder[index] === id) return true;
    const needed = transitionAt(transitions, index) + transitionAt(transitions, index + 1);
    return getClipDuration(clip) >= needed + MIN_CLIP_DURATION - EPS;
  });
}

/**
 * Finalize an edit: re-key base transitions when the base order changed,
 * rewrite base start times from segment math, and validate xfade lengths.
 */
export function finalize(
  prev: EditState,
  tracks: Track[],
  clips: Clip[],
  alias?: Map<string, string>,
): EditResult {
  const prevOrder = baseLaneOrder(prev.tracks);
  const nextOrder = baseLaneOrder(tracks);
  const orderChanged =
    prevOrder.length !== nextOrder.length || prevOrder.some((id, i) => id !== nextOrder[i]);
  const transitions = orderChanged
    ? remapBaseTransitions(prevOrder, nextOrder, prev.transitions, alias)
    : prev.transitions;
  const normalized = normalizeBaseLane(tracks, clips, transitions);
  if (!baseDurationsValid(prev, normalized, clips, transitions)) {
    return fail('A clip would become shorter than its transitions.');
  }
  return done({ tracks: normalized, clips, transitions });
}

export interface Located {
  track: Track;
  trackIndex: number;
  /** The lane's items sorted by start time. */
  items: TrackItem[];
  /** Index of the clip within `items`. */
  index: number;
  clip: Clip;
  base: boolean;
}

export function locate(state: EditState, clipId: string): Located | string {
  const found = findClipTrack(state.tracks, clipId);
  const clip = state.clips.find((c) => c.id === clipId);
  if (!found || !clip) return 'That clip is not on the timeline.';
  if (found.track.locked) return lockedReason(found.track);
  const items = sortedItems(found.track);
  return {
    track: found.track,
    trackIndex: found.trackIndex,
    items,
    index: items.findIndex((i) => i.clipId === clipId),
    clip,
    base: isBaseLane(state.tracks, found.track.id),
  };
}

export function itemEnd(item: TrackItem, byId: Map<string, Clip>): number {
  const clip = byId.get(item.clipId);
  return item.startTime + (clip ? getClipDuration(clip) : 0);
}

/** Two items touch when one ends where the next starts (base lane: always). */
export function adjacent(a: TrackItem, b: TrackItem, byId: Map<string, Clip>, base: boolean): boolean {
  return base || Math.abs(itemEnd(a, byId) - b.startTime) < 1e-3;
}

export function withItems(tracks: Track[], trackId: string, items: TrackItem[]): Track[] {
  return tracks.map((t) => (t.id === trackId ? { ...t, items } : t));
}

/**
 * Shift every item that starts at or after `point` by `shift` seconds on the
 * lanes ripple reaches. Returns a reason when a locked lane would have to move
 * or a leftward shift would collide with an item that stays put.
 */
export function rippleLanes(
  tracks: Track[],
  clips: Clip[],
  editedTrackId: string,
  point: number,
  shift: number,
  options: RippleOptions,
  skipClipIds: Set<string> = new Set(),
): Track[] | string {
  if (Math.abs(shift) < EPS) return tracks;
  const byId = clipMap(clips);
  const baseId = videoTracks(tracks)[0]?.id;
  const next: Track[] = [];
  for (const track of tracks) {
    const reached =
      track.id === editedTrackId
      // The base lane is gapless and positioned by segment math, so a linked
      // ripple from another lane cannot push it — it only ripples itself.
      || (options.linked && track.id !== baseId && track.kind !== 'text');
    if (!reached) {
      next.push(track);
      continue;
    }
    const moving = track.items.filter(
      (i) => !skipClipIds.has(i.clipId) && i.startTime >= point - EPS,
    );
    if (moving.length === 0) {
      next.push(track);
      continue;
    }
    if (track.locked) return `${lockedReason(track)} (ripple would move it)`;
    if (shift < 0) {
      const target = point + shift;
      const blocked = track.items.some(
        (i) =>
          !skipClipIds.has(i.clipId)
          && i.startTime < point - EPS
          && itemEnd(i, byId) > target + EPS,
      );
      if (blocked && track.id !== editedTrackId) {
        return `Not enough room on ${laneLabel(track)} to ripple.`;
      }
    }
    next.push({
      ...track,
      items: track.items.map((i) =>
        !skipClipIds.has(i.clipId) && i.startTime >= point - EPS
          ? { ...i, startTime: Math.max(0, i.startTime + shift) }
          : i,
      ),
    });
  }
  return next;
}
