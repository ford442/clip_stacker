import type { Clip, Track, TrackItem } from '../types';
import { createClipId } from './media';
import { getClipDuration } from './clipTiming';
import { acceptsClipKind, cloneTracks, findClipTrack } from './trackModel';
import {
  baseLaneOrder,
  clipMap,
  EPS,
  fail,
  finalize,
  isBaseLane,
  itemEnd,
  laneLabel,
  locate,
  lockedReason,
  normalizeBaseLane,
  remapBaseTransitions,
  replaceClips,
  rippleLanes,
  shiftClipTrim,
  sortedItems,
  untrimmableReason,
  withItems,
  type DropEditMode,
  type EditResult,
  type EditState,
  type RippleOptions,
} from './editModeCore';

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
    const prevOrder = baseLaneOrder(state.tracks);
    const transitions = remapBaseTransitions(prevOrder, baseLaneOrder(tracks), state.transitions);
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
 * Duplicate: place `copy` (a new pool clip, see `duplicateClip`) directly after
 * `clipId` on the same lane.
 *
 * Overlay and audio lanes follow the drop mode — `insert` ripples later items
 * right by the copy's length, `overwrite` covers whatever sits there. The base
 * lane always inserts: it is a gapless edit list whose next clip starts inside
 * the source's outgoing xfade, so "overwrite at the source's end" would eat
 * that clip's head. The xfade that left the source now leaves the copy (the
 * copy is aliased to the source, exactly like a split tail), so the cut into
 * the following clip looks the same as before.
 */
export function duplicateItem(
  state: EditState,
  clipId: string,
  copy: Clip,
  mode: DropEditMode,
  options: RippleOptions = {},
): EditResult {
  const at = locate(state, clipId);
  if (typeof at === 'string') return fail(at);
  const clips = addToPool(state.clips, clipId, copy);
  const byId = clipMap(clips);
  const self = at.items[at.index];

  if (!at.base) {
    return dropEdit({ ...state, clips }, mode, copy.id, at.track.id, itemEnd(self, byId), options);
  }

  // The cut the copy goes into: where the next base clip starts (inside any
  // xfade), or the lane's end.
  const nextItem = at.items[at.index + 1];
  const cut = nextItem ? nextItem.startTime : itemEnd(self, byId);
  let tracks = state.tracks;
  if (options.linked) {
    const rippled = rippleLanes(tracks, clips, at.track.id, cut, getClipDuration(copy), options);
    if (typeof rippled === 'string') return fail(rippled);
    tracks = rippled;
  }
  const order = at.items.map((i) => i.clipId);
  order.splice(at.index + 1, 0, copy.id);
  // Placeholder start times that only encode order — `finalize` rewrites the
  // base lane from segment math.
  const items = order.map((id, i) => ({ clipId: id, startTime: i }));
  return finalize(state, withItems(tracks, at.track.id, items), clips, new Map([[copy.id, clipId]]));
}
