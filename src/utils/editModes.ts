import type { Clip, ClipTransition, Track, TrackItem } from '../types';
import { createClipId, MIN_CLIP_DURATION } from './media';
// Submodule imports (not the `./project` / `./previewComposition` barrels) keep
// this file out of the trackModel ↔ project import cycle — see trackStacking.ts.
import { getClipDuration } from './project/clipHelpers';
import { buildClipTimelineSegments, isActiveTransition } from './previewCompositionSegments';
import { getClipLoopCount, getClipPlaybackRate } from './playbackRate';
import { clipHasRateAutomation } from './timeRemap';
import { acceptsClipKind, cloneTracks, findClipTrack, videoTracks } from './trackModel';

/**
 * NLE edit modes (#168 follow-up): overwrite, insert, ripple, roll, slip, slide.
 *
 * Every operation here is pure — it takes the three editable slices (`tracks`,
 * the clip pool and the base-lane transitions) and returns new ones, or a
 * human-readable reason the edit was refused. The store commits a successful
 * result in one step behind a single `pushHistory`, so one undo restores both
 * lane placements and clip trims.
 *
 * Conventions:
 *
 * - A `Clip` *is* a media placement: its trim window says which part of the
 *   source plays. Edits that split an item duplicate the placement (new clip
 *   id, same `File` / object URL) and edits that cover an item drop the
 *   placement — source files are never touched.
 * - Deltas are **output-timeline seconds**. They are converted to source time
 *   with the clip's constant playback rate; speed-ramped or looped clips are
 *   refused rather than trimmed approximately.
 * - Ripple is **lane-local** by default. `linked: true` also shifts every other
 *   lane (sync-lock), and a locked lane that would have to move blocks the edit.
 * - The base video lane (the first video track) is a gapless edit list whose
 *   output positions come from transition-aware segment math. After any edit
 *   touching it, its `TrackItem.startTime`s are rewritten from
 *   `buildClipTimelineSegments` so placements and segment math never disagree,
 *   and its xfade transitions are re-keyed to the clip pairs they joined.
 */

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
const EPS = 1e-4;

function fail(reason: string): EditResult {
  return { ok: false, reason };
}

function done(state: EditState): EditResult {
  return { ok: true, state };
}

function laneLabel(track: Track): string {
  return track.label ?? track.id;
}

function lockedReason(track: Track): string {
  return `${laneLabel(track)} is locked — unlock the lane to edit it.`;
}

/** True when `trackId` is the base sequence (first video lane). */
export function isBaseLane(tracks: Track[], trackId: string): boolean {
  return videoTracks(tracks)[0]?.id === trackId;
}

function sortedItems(track: Track): TrackItem[] {
  return [...track.items].sort((a, b) => a.startTime - b.startTime);
}

function clipMap(clips: Clip[]): Map<string, Clip> {
  return new Map(clips.map((c) => [c.id, c]));
}

function sourceEnd(clip: Clip): number {
  return Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
}

/** Why a clip's trim window cannot be moved by an output-time delta, if at all. */
function untrimmableReason(clip: Clip): string | null {
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

function replaceClips(clips: Clip[], updates: Map<string, Clip>): Clip[] {
  if (updates.size === 0) return clips;
  return clips.map((c) => updates.get(c.id) ?? c);
}

/** Transition-in duration for base-lane slot `index` (0 when none). */
function transitionAt(transitions: ClipTransition[], index: number): number {
  const t = transitions.find((x) => x.afterClipIndex === index);
  return isActiveTransition(t) ? t.duration : 0;
}

function baseOrder(tracks: Track[]): string[] {
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
  const prevOrder = baseOrder(prev.tracks);
  return baseOrder(tracks).every((id, index) => {
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
function finalize(
  prev: EditState,
  tracks: Track[],
  clips: Clip[],
  alias?: Map<string, string>,
): EditResult {
  const prevOrder = baseOrder(prev.tracks);
  const nextOrder = baseOrder(tracks);
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

interface Located {
  track: Track;
  trackIndex: number;
  /** The lane's items sorted by start time. */
  items: TrackItem[];
  /** Index of the clip within `items`. */
  index: number;
  clip: Clip;
  base: boolean;
}

function locate(state: EditState, clipId: string): Located | string {
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

function itemEnd(item: TrackItem, byId: Map<string, Clip>): number {
  const clip = byId.get(item.clipId);
  return item.startTime + (clip ? getClipDuration(clip) : 0);
}

/** Two items touch when one ends where the next starts (base lane: always). */
function adjacent(a: TrackItem, b: TrackItem, byId: Map<string, Clip>, base: boolean): boolean {
  return base || Math.abs(itemEnd(a, byId) - b.startTime) < 1e-3;
}

function withItems(tracks: Track[], trackId: string, items: TrackItem[]): Track[] {
  return tracks.map((t) => (t.id === trackId ? { ...t, items } : t));
}

/**
 * Shift every item that starts at or after `point` by `shift` seconds on the
 * lanes ripple reaches. Returns a reason when a locked lane would have to move
 * or a leftward shift would collide with an item that stays put.
 */
function rippleLanes(
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

// ─── Drop edits ──────────────────────────────────────────────────────────────

interface DropPrep {
  /** Tracks with the dropped clip's previous placement removed. */
  tracks: Track[];
  target: Track;
  clip: Clip;
  duration: number;
  startTime: number;
}

function prepareDrop(
  state: EditState,
  clipId: string,
  trackId: string,
  startTime: number,
): DropPrep | string {
  const clip = state.clips.find((c) => c.id === clipId);
  if (!clip) return 'That clip is not in the project.';
  const target = state.tracks.find((t) => t.id === trackId);
  if (!target) return 'That lane no longer exists.';
  if (target.locked) return lockedReason(target);
  if (!acceptsClipKind(target, clip.kind)) {
    return `Cannot place this clip on ${laneLabel(target)}.`;
  }
  const source = findClipTrack(state.tracks, clipId);
  if (source?.track.locked) return lockedReason(source.track);

  let tracks = cloneTracks(state.tracks).map((t) => ({
    ...t,
    items: t.items.filter((i) => i.clipId !== clipId),
  }));
  // Lifting a clip out of the gapless base lane closes its slot first, so the
  // drop position is measured against where the base clips will actually play.
  if (source && isBaseLane(state.tracks, source.track.id)) {
    const prevOrder = baseOrder(state.tracks);
    const transitions = remapBaseTransitions(prevOrder, baseOrder(tracks), state.transitions);
    tracks = normalizeBaseLane(tracks, state.clips, transitions);
  }
  return {
    tracks,
    target: tracks.find((t) => t.id === trackId)!,
    clip,
    duration: getClipDuration(clip),
    startTime: Math.max(0, startTime),
  };
}

function insertItem(items: TrackItem[], item: TrackItem): TrackItem[] {
  return [...items, item].sort((a, b) => a.startTime - b.startTime);
}

/** Copy a clip as a new placement of the same media (split tail). */
function tailCopy(clip: Clip): Clip {
  return {
    ...clip,
    id: createClipId(),
    groupId: undefined,
    groupVariant: undefined,
  };
}

/** Insert `added` into the pool right after `afterId` (keeps pool order readable). */
function addToPool(clips: Clip[], afterId: string, added: Clip): Clip[] {
  const index = clips.findIndex((c) => c.id === afterId);
  const next = [...clips];
  next.splice(index < 0 ? next.length : index + 1, 0, added);
  return next;
}

/**
 * Overwrite: place the clip at `startTime` on the lane and cover whatever was
 * underneath — items fully under it are removed, items straddling an edge are
 * trimmed, and an item spanning the whole range is split around it. Nothing
 * later on the lane moves.
 */
export function overwriteEdit(
  state: EditState,
  clipId: string,
  trackId: string,
  startTime: number,
): EditResult {
  const prep = prepareDrop(state, clipId, trackId, startTime);
  if (typeof prep === 'string') return fail(prep);
  const s = prep.startTime;
  const e = s + prep.duration;

  let clips = state.clips;
  const alias = new Map<string, string>();
  const removed = new Set<string>();
  const items: TrackItem[] = [];

  for (const item of sortedItems(prep.target)) {
    const clip = clips.find((c) => c.id === item.clipId);
    if (!clip) {
      items.push(item);
      continue;
    }
    const a = item.startTime;
    const b = a + getClipDuration(clip);
    if (b <= s + EPS || a >= e - EPS) {
      items.push(item);
      continue;
    }
    const coversHead = a >= s - EPS;
    const coversTail = b <= e + EPS;
    if (coversHead && coversTail) {
      removed.add(clip.id);
      continue;
    }
    const reason = untrimmableReason(clip);
    if (reason) return fail(reason);

    if (!coversHead && !coversTail) {
      // Split around the dropped clip: head keeps the id, tail is a new placement.
      const head = shiftClipTrim(clip, 0, s - b);
      const tail = shiftClipTrim(tailCopy(clip), e - a, 0);
      if (!head || !tail) return fail('Overwrite would leave a sliver shorter than 0.1s.');
      clips = addToPool(replaceClips(clips, new Map([[head.id, head]])), clip.id, tail);
      alias.set(tail.id, clip.id);
      items.push({ clipId: head.id, startTime: a }, { clipId: tail.id, startTime: e });
    } else if (!coversHead) {
      const head = shiftClipTrim(clip, 0, s - b);
      if (!head) return fail('Overwrite would leave a sliver shorter than 0.1s.');
      clips = replaceClips(clips, new Map([[head.id, head]]));
      items.push({ clipId: head.id, startTime: a });
    } else {
      const tail = shiftClipTrim(clip, e - a, 0);
      if (!tail) return fail('Overwrite would leave a sliver shorter than 0.1s.');
      clips = replaceClips(clips, new Map([[tail.id, tail]]));
      items.push({ clipId: tail.id, startTime: e });
    }
  }

  if (removed.size > 0) clips = clips.filter((c) => !removed.has(c.id));
  const tracks = withItems(prep.tracks, trackId, insertItem(items, { clipId, startTime: s }));
  return finalize(state, tracks, clips, alias);
}

/**
 * Insert: place the clip at `startTime` and push everything at or after that
 * point later by the clip's length. An item under the insert point is split so
 * its tail moves with the ripple.
 */
export function insertEdit(
  state: EditState,
  clipId: string,
  trackId: string,
  startTime: number,
  options: RippleOptions = {},
): EditResult {
  const prep = prepareDrop(state, clipId, trackId, startTime);
  if (typeof prep === 'string') return fail(prep);
  let s = prep.startTime;

  let clips = state.clips;
  const alias = new Map<string, string>();
  let laneItems = sortedItems(prep.target);

  const straddling = laneItems.find((item) => {
    const clip = clips.find((c) => c.id === item.clipId);
    if (!clip) return false;
    return item.startTime < s - EPS && item.startTime + getClipDuration(clip) > s + EPS;
  });
  if (straddling) {
    const clip = clips.find((c) => c.id === straddling.clipId)!;
    const cut = s - straddling.startTime;
    const reason = untrimmableReason(clip);
    const head = reason ? null : shiftClipTrim(clip, 0, cut - getClipDuration(clip));
    const tail = reason ? null : shiftClipTrim(tailCopy(clip), cut, 0);
    if (!head || !tail) {
      // Can't cut here — insert at the edit point after it instead.
      s = straddling.startTime + getClipDuration(clip);
    } else {
      clips = addToPool(replaceClips(clips, new Map([[head.id, head]])), clip.id, tail);
      alias.set(tail.id, clip.id);
      laneItems = insertItem(laneItems, { clipId: tail.id, startTime: s });
    }
  }

  const tracks = withItems(prep.tracks, trackId, laneItems);
  const rippled = rippleLanes(tracks, clips, trackId, s, prep.duration, options);
  if (typeof rippled === 'string') return fail(rippled);
  const placed = rippled.map((t) =>
    t.id === trackId ? { ...t, items: insertItem(t.items, { clipId, startTime: s }) } : t,
  );
  return finalize(state, placed, clips, alias);
}

/** Dispatch a drop by mode. */
export function dropEdit(
  state: EditState,
  mode: DropEditMode,
  clipId: string,
  trackId: string,
  startTime: number,
  options: RippleOptions = {},
): EditResult {
  return mode === 'insert'
    ? insertEdit(state, clipId, trackId, startTime, options)
    : overwriteEdit(state, clipId, trackId, startTime);
}

/**
 * Apply the sticky tool to the selected clip for a keyboard nudge of `delta`
 * output seconds. `select` has no nudge behaviour.
 */
export function nudgeWithTool(
  state: EditState,
  tool: TimelineEditTool,
  clipId: string,
  delta: number,
  options: RippleOptions = {},
): EditResult {
  switch (tool) {
    case 'ripple':
      return rippleTrim(state, clipId, 'out', delta, options);
    case 'roll':
      return rollEdit(state, clipId, delta);
    case 'slip':
      return slipClip(state, clipId, delta);
    case 'slide':
      return slideClip(state, clipId, delta);
    default:
      return fail('Pick the Ripple, Roll, Slip or Slide tool to nudge an edit.');
  }
}
