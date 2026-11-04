import type { Clip } from '../types';
import { getClipDuration } from './clipTiming';
import {
  adjacent,
  clipMap,
  EPS,
  fail,
  finalize,
  itemEnd,
  locate,
  replaceClips,
  rippleLanes,
  shiftClipTrim,
  untrimmableReason,
  withItems,
  type EditResult,
  type EditState,
  type RippleOptions,
} from './editModeCore';

// ─── Trim-style edits ────────────────────────────────────────────────────────

/**
 * Roll the edit point at the **out** of `leftClipId`: A's out-point and the
 * next clip's in-point move together by `delta`, so the pair's combined length
 * and everything after it stay put.
 */
export function rollEdit(state: EditState, leftClipId: string, delta: number): EditResult {
  const at = locate(state, leftClipId);
  if (typeof at === 'string') return fail(at);
  const rightItem = at.items[at.index + 1];
  if (!rightItem) return fail('Roll needs a clip after the edit point.');
  const byId = clipMap(state.clips);
  const right = byId.get(rightItem.clipId);
  if (!right) return fail('Roll needs a clip after the edit point.');
  if (!adjacent(at.items[at.index], rightItem, byId, at.base)) {
    return fail('Roll needs two clips that touch — close the gap first.');
  }
  const reason = untrimmableReason(at.clip) ?? untrimmableReason(right);
  if (reason) return fail(reason);

  const nextLeft = shiftClipTrim(at.clip, 0, delta);
  const nextRight = shiftClipTrim(right, delta, 0);
  if (!nextLeft || !nextRight) return fail('Roll would run past the source media.');

  const clips = replaceClips(
    state.clips,
    new Map([[nextLeft.id, nextLeft], [nextRight.id, nextRight]]),
  );
  // Base-lane positions are re-derived from order in `finalize`; moving a
  // start here could reorder the lane when xfades overlap the clips.
  const items = at.items.map((i) =>
    !at.base && i.clipId === right.id ? { ...i, startTime: i.startTime + delta } : i,
  );
  return finalize(state, withItems(state.tracks, at.track.id, items), clips);
}

/**
 * Slip: slide the trim window inside the source by `delta` (positive shows
 * later material). Timeline position and duration are unchanged.
 */
export function slipClip(state: EditState, clipId: string, delta: number): EditResult {
  const at = locate(state, clipId);
  if (typeof at === 'string') return fail(at);
  const reason = untrimmableReason(at.clip);
  if (reason) return fail(reason);
  const next = shiftClipTrim(at.clip, delta, delta);
  if (!next) return fail('Slip would run past the source media.');
  return finalize(state, state.tracks, replaceClips(state.clips, new Map([[next.id, next]])));
}

/**
 * Slide: move the clip by `delta` while its neighbours absorb the change — the
 * clip before extends / shortens its out-point, the clip after moves its
 * in-point — so the group's total length is constant. On an overlay lane a
 * side with a gap instead of a touching neighbour just uses up that gap.
 */
export function slideClip(state: EditState, clipId: string, delta: number): EditResult {
  const at = locate(state, clipId);
  if (typeof at === 'string') return fail(at);
  const byId = clipMap(state.clips);
  const self = at.items[at.index];
  const prevItem = at.items[at.index - 1];
  const nextItem = at.items[at.index + 1];

  if (at.base && (!prevItem || !nextItem)) {
    return fail('Slide needs a clip on each side on the main lane.');
  }

  const updates = new Map<string, Clip>();
  const starts = new Map<string, number>([[clipId, self.startTime + delta]]);

  if (prevItem && adjacent(prevItem, self, byId, at.base)) {
    const prev = byId.get(prevItem.clipId)!;
    const reason = untrimmableReason(prev);
    if (reason) return fail(reason);
    const next = shiftClipTrim(prev, 0, delta);
    if (!next) return fail('Slide would run past the previous clip\'s media.');
    updates.set(prev.id, next);
  } else {
    const floor = prevItem ? itemEnd(prevItem, byId) : 0;
    if (self.startTime + delta < floor - EPS) return fail('Slide would overlap the previous clip.');
  }

  if (nextItem && adjacent(self, nextItem, byId, at.base)) {
    const nextClip = byId.get(nextItem.clipId)!;
    const reason = untrimmableReason(nextClip);
    if (reason) return fail(reason);
    const next = shiftClipTrim(nextClip, delta, 0);
    if (!next) return fail('Slide would run past the next clip\'s media.');
    updates.set(nextClip.id, next);
    starts.set(nextClip.id, nextItem.startTime + delta);
  } else if (nextItem) {
    if (itemEnd(self, byId) + delta > nextItem.startTime + EPS) {
      return fail('Slide would overlap the next clip.');
    }
  }

  const items = at.items.map((i) =>
    !at.base && starts.has(i.clipId) ? { ...i, startTime: starts.get(i.clipId)! } : i,
  );
  return finalize(
    state,
    withItems(state.tracks, at.track.id, items),
    replaceClips(state.clips, updates),
  );
}

/**
 * Ripple trim: move the clip's `in` or `out` point by `delta` and shift every
 * later item on the lane (and, when linked, on every other lane) so no gap
 * opens and nothing is covered.
 */
export function rippleTrim(
  state: EditState,
  clipId: string,
  edge: 'in' | 'out',
  delta: number,
  options: RippleOptions = {},
): EditResult {
  const at = locate(state, clipId);
  if (typeof at === 'string') return fail(at);
  const reason = untrimmableReason(at.clip);
  if (reason) return fail(reason);
  const next = edge === 'in' ? shiftClipTrim(at.clip, delta, 0) : shiftClipTrim(at.clip, 0, delta);
  if (!next) return fail('Trim would run past the source media.');

  const byId = clipMap(state.clips);
  const oldEnd = itemEnd(at.items[at.index], byId);
  const change = getClipDuration(next) - getClipDuration(at.clip);
  const clips = replaceClips(state.clips, new Map([[next.id, next]]));
  const rippled = rippleLanes(
    state.tracks, clips, at.track.id, oldEnd, change, options, new Set([clipId]),
  );
  if (typeof rippled === 'string') return fail(rippled);
  return finalize(state, rippled, clips);
}

/**
 * Ripple delete: drop the placement and close the gap it leaves by pulling
 * later items left.
 */
export function rippleDelete(
  state: EditState,
  clipId: string,
  options: RippleOptions = {},
): EditResult {
  const at = locate(state, clipId);
  if (typeof at === 'string') return fail(at);
  const byId = clipMap(state.clips);
  const self = at.items[at.index];
  const end = itemEnd(self, byId);
  const width = end - self.startTime;

  const without = state.tracks.map((t) =>
    t.id === at.track.id ? { ...t, items: t.items.filter((i) => i.clipId !== clipId) } : t,
  );
  const rippled = rippleLanes(without, state.clips, at.track.id, end, -width, options);
  if (typeof rippled === 'string') return fail(rippled);
  return finalize(state, rippled, state.clips.filter((c) => c.id !== clipId));
}
