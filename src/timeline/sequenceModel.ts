/**
 * Nested sequences — the pure edit model behind the editor store.
 *
 * The editor always edits one sequence through its top-level fields
 * (`tracks`, `clips`, `clipGroups`, `transitions`, `textOverlays`), so every
 * existing edit, the timeline UI and undo work unchanged inside a nested
 * sequence. Around that live body the store keeps:
 *
 * - `sequences` — every nested sequence. The entry of the one being edited
 *   is stale while it is open; the live fields are its truth.
 * - `sequencePath` — the open sequences, outermost first (`[]` = the root).
 * - `rootStash` — the root's body while a nested sequence is open.
 *
 * Everything here works on the *committed* form ({@link CommittedSequences}:
 * the root body plus every sequence, live edits written back) and converts
 * back with {@link fromCommitted}, so enter / exit / nest / place are plain
 * functions of the whole graph.
 */

import type { Clip, ClipGroup, ClipTransition, Sequence, SequenceBody, TextOverlay, Track } from '../types';
import { MIN_CLIP_DURATION, createClipId } from '../media/media';
import { timelinePlanDuration } from '../composition/previewComposition';
import { getEffectiveTimelineClips } from './trackModel';
import { cloneTrack, computeTrackEnd, createDefaultTracks, videoTracks } from './trackBasics';
import { baseLaneOrder, lockedReason, normalizeBaseLane } from './editModeCore';
import { sequenceIdOf, sequenceWouldCycle } from './sequenceResolve';

/** The editor-store fields the sequence model reads and writes. */
export interface SequenceEditorState extends SequenceBody {
  sequences: Sequence[];
  sequencePath: string[];
  rootStash: SequenceBody | null;
}

/** The whole graph with live edits written back. */
export interface CommittedSequences {
  root: SequenceBody;
  sequences: Sequence[];
  path: string[];
}

export type SequenceEditResult =
  | { ok: true; state: SequenceEditorState }
  | { ok: false; reason: string };

/** MIME type of a sequence clip's empty placeholder `File`. */
export const SEQUENCE_FILE_TYPE = 'application/x-clip-stacker-sequence';

const ok = (state: SequenceEditorState): SequenceEditResult => ({ ok: true, state });
const fail = (reason: string): SequenceEditResult => ({ ok: false, reason });

export function bodyOf(state: SequenceBody): SequenceBody {
  return {
    tracks: state.tracks,
    clips: state.clips,
    clipGroups: state.clipGroups,
    transitions: state.transitions,
    textOverlays: state.textOverlays,
  };
}

export function emptySequenceBody(): SequenceBody {
  return { tracks: createDefaultTracks(), clips: [], clipGroups: [], transitions: [], textOverlays: [] };
}

/** The sequence being edited, or null at the root. */
export function activeSequenceId(state: Pick<SequenceEditorState, 'sequencePath'>): string | null {
  return state.sequencePath[state.sequencePath.length - 1] ?? null;
}

let committedMemo: { key: unknown[]; value: Sequence[] } | null = null;

/**
 * `state.sequences` with the open sequence's entry replaced by the live
 * fields. Memoized on the identity of its inputs, so selectors get one array
 * per edit.
 */
export function committedSequences(state: SequenceEditorState): Sequence[] {
  const active = activeSequenceId(state);
  if (active === null) return state.sequences;
  const key = [state.sequences, active, state.tracks, state.clips, state.clipGroups, state.transitions, state.textOverlays];
  if (committedMemo && committedMemo.key.every((part, i) => part === key[i])) return committedMemo.value;
  const value = state.sequences.map((seq) => (seq.id === active ? { ...seq, ...bodyOf(state) } : seq));
  committedMemo = { key, value };
  return value;
}

/** The root sequence's body (the live fields at the root, else the stash). */
export function committedRootBody(state: SequenceEditorState): SequenceBody {
  return state.sequencePath.length === 0 || !state.rootStash ? bodyOf(state) : state.rootStash;
}

export function toCommitted(state: SequenceEditorState): CommittedSequences {
  return { root: committedRootBody(state), sequences: committedSequences(state), path: state.sequencePath };
}

/** Back to store fields: the innermost open sequence becomes the live body. */
export function fromCommitted(committed: CommittedSequences): SequenceEditorState {
  const active = committed.path[committed.path.length - 1];
  const open = active ? committed.sequences.find((seq) => seq.id === active) : undefined;
  const live = open ? bodyOf(open) : committed.root;
  return {
    ...live,
    sequences: committed.sequences,
    sequencePath: open ? committed.path : [],
    rootStash: open ? committed.root : null,
  };
}

let bodiesMemo: { sequences: Sequence[]; value: Map<string, SequenceBody> } | null = null;

/** Committed sequence bodies by id — what playback resolves sequence clips against. */
export function sequenceBodies(state: SequenceEditorState): Map<string, SequenceBody> {
  const sequences = committedSequences(state);
  if (bodiesMemo?.sequences === sequences) return bodiesMemo.value;
  const value = new Map<string, SequenceBody>(sequences.map((seq) => [seq.id, seq]));
  bodiesMemo = { sequences, value };
  return value;
}

/** Every clip in every sequence (root included) — object URLs owned by the session. */
export function allSequenceClips(state: SequenceEditorState): Clip[] {
  const { root, sequences } = toCommitted(state);
  if (sequences.length === 0) return root.clips;
  return [...root.clips, ...sequences.flatMap((seq) => seq.clips)];
}

// ── Durations ────────────────────────────────────────────────────────────────

/** Output duration of a sequence body, as the composition plan computes it. */
export function sequenceBodyDuration(body: SequenceBody): number {
  return timelinePlanDuration(
    getEffectiveTimelineClips(body.tracks, body.clips, body.clipGroups),
    body.transitions,
  );
}

function withSequenceDuration(clip: Clip, duration: number): Clip {
  const length = Math.max(MIN_CLIP_DURATION, duration);
  let { trimStart, trimEnd } = clip;
  if (Number.isFinite(trimEnd) && trimEnd > length) trimEnd = NaN;
  if (trimStart > length - MIN_CLIP_DURATION) trimStart = 0;
  if (clip.duration === length && trimStart === clip.trimStart && Object.is(trimEnd, clip.trimEnd)) return clip;
  return { ...clip, duration: length, trimStart, trimEnd };
}

/**
 * Bring every sequence clip's `duration` in line with the sequence it plays
 * (bottom-up, so a sequence inside a sequence settles first), clamp trims a
 * shorter sequence no longer covers, and re-flow base lanes whose clips
 * changed length. Bodies that need nothing keep their identity.
 */
export function syncSequenceDurations(committed: CommittedSequences): CommittedSequences {
  const byId = new Map(committed.sequences.map((seq) => [seq.id, seq]));
  const settled = new Map<string, { body: SequenceBody; duration: number }>();
  const visiting = new Set<string>();

  const settle = (id: string): number | null => {
    const done = settled.get(id);
    if (done) return done.duration;
    const seq = byId.get(id);
    if (!seq || visiting.has(id)) return null;
    visiting.add(id);
    const body = fixBody(seq);
    visiting.delete(id);
    const duration = sequenceBodyDuration(body);
    settled.set(id, { body, duration });
    return duration;
  };

  const fixBody = (body: SequenceBody): SequenceBody => {
    let changed = false;
    const clips = body.clips.map((clip) => {
      const id = sequenceIdOf(clip);
      if (!id) return clip;
      const duration = settle(id);
      if (duration === null) return clip;
      const next = withSequenceDuration(clip, duration);
      if (next !== clip) changed = true;
      return next;
    });
    if (!changed) return body;
    return { ...body, clips, tracks: normalizeBaseLane(body.tracks, clips, body.transitions) };
  };

  const root = fixBody(committed.root);
  let sequencesChanged = false;
  const sequences = committed.sequences.map((seq) => {
    settle(seq.id);
    const body = settled.get(seq.id)?.body ?? seq;
    if (body === seq) return seq;
    sequencesChanged = true;
    return { ...seq, ...bodyOf(body) };
  });
  if (root === committed.root && !sequencesChanged) return committed;
  return { root, sequences: sequencesChanged ? sequences : committed.sequences, path: committed.path };
}

// ── Sequence clips ───────────────────────────────────────────────────────────

/** A clip that plays `sequence` from its start, `duration` long. */
export function createSequenceClip(
  sequence: Pick<Sequence, 'id' | 'name'>,
  duration: number,
  id: string = createClipId(),
): Clip {
  return {
    id,
    // Nothing reads this file: a sequence clip has no media of its own.
    file: new File([], `${sequence.name}.sequence`, { type: SEQUENCE_FILE_TYPE }),
    objectUrl: '',
    title: sequence.name,
    kind: 'video',
    duration: Math.max(MIN_CLIP_DURATION, duration),
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    source: { type: 'sequence', sequenceId: sequence.id },
  };
}

/** Ids of the sequences that contain a clip playing `sequenceId` (null = the root). */
export function sequencesUsing(committed: CommittedSequences, sequenceId: string): Array<string | null> {
  const uses = (body: SequenceBody) => body.clips.some((clip) => sequenceIdOf(clip) === sequenceId);
  return [
    ...(uses(committed.root) ? [null] : []),
    ...committed.sequences.filter(uses).map((seq) => seq.id),
  ];
}

// ── Edits ────────────────────────────────────────────────────────────────────

/** Open `sequenceId` for editing (pushes it on the breadcrumb). */
export function enterSequence(state: SequenceEditorState, sequenceId: string): SequenceEditResult {
  if (state.sequencePath.includes(sequenceId)) return fail('That sequence is already open.');
  const committed = toCommitted(state);
  if (!committed.sequences.some((seq) => seq.id === sequenceId)) return fail('That sequence no longer exists.');
  return ok(fromCommitted({ ...committed, path: [...committed.path, sequenceId] }));
}

/**
 * Close the open sequence and return to its parent. Sequence clips anywhere
 * in the project take the edited sequence's new length.
 */
export function exitSequence(state: SequenceEditorState): SequenceEditResult {
  if (state.sequencePath.length === 0) return fail('The main timeline has no parent.');
  const committed = toCommitted(state);
  return ok(fromCommitted(syncSequenceDurations({ ...committed, path: committed.path.slice(0, -1) })));
}

/** Leave every open sequence (project save / reset): back at the root. */
export function exitToRoot(state: SequenceEditorState): SequenceEditorState {
  if (state.sequencePath.length === 0) return state;
  return fromCommitted(syncSequenceDurations({ ...toCommitted(state), path: [] }));
}

/** Add an empty sequence (not placed anywhere yet). */
export function createSequence(state: SequenceEditorState, sequence: Pick<Sequence, 'id' | 'name'>): SequenceEditResult {
  const committed = toCommitted(state);
  if (committed.sequences.some((seq) => seq.id === sequence.id)) return fail('A sequence with that id exists.');
  return ok(fromCommitted({ ...committed, sequences: [...committed.sequences, { ...sequence, ...emptySequenceBody() }] }));
}

export function renameSequence(state: SequenceEditorState, sequenceId: string, name: string): SequenceEditResult {
  const trimmed = name.trim();
  if (!trimmed) return fail('A sequence needs a name.');
  const committed = toCommitted(state);
  if (!committed.sequences.some((seq) => seq.id === sequenceId)) return fail('That sequence no longer exists.');
  const rename = (clip: Clip) =>
    sequenceIdOf(clip) === sequenceId && clip.title !== trimmed ? { ...clip, title: trimmed } : clip;
  const renameBody = <T extends SequenceBody>(body: T): T => {
    const clips = body.clips.map(rename);
    return clips.some((clip, i) => clip !== body.clips[i]) ? { ...body, clips } : body;
  };
  return ok(
    fromCommitted({
      root: renameBody(committed.root),
      sequences: committed.sequences.map((seq) => renameBody(seq.id === sequenceId ? { ...seq, name: trimmed } : seq)),
      path: committed.path,
    }),
  );
}

/** Delete a sequence nothing plays and nobody has open. */
export function deleteSequence(state: SequenceEditorState, sequenceId: string): SequenceEditResult {
  const committed = toCommitted(state);
  if (state.sequencePath.includes(sequenceId)) return fail('Close the sequence before deleting it.');
  if (sequencesUsing(committed, sequenceId).length > 0) {
    return fail('The sequence is still on a timeline — remove its clips first.');
  }
  return ok(fromCommitted({ ...committed, sequences: committed.sequences.filter((seq) => seq.id !== sequenceId) }));
}

/**
 * Place `sequenceId` at the end of the open timeline's main lane. Refused when
 * it would contain itself (directly or through other sequences) or is empty.
 */
export function placeSequence(
  state: SequenceEditorState,
  sequenceId: string,
  clipId: string = createClipId(),
): SequenceEditResult {
  const committed = toCommitted(state);
  const seq = committed.sequences.find((item) => item.id === sequenceId);
  if (!seq) return fail('That sequence no longer exists.');
  if (sequenceWouldCycle(committed.sequences, activeSequenceId(state), sequenceId)) {
    return fail(`“${seq.name}” contains this sequence — placing it here would nest it inside itself.`);
  }
  const duration = sequenceBodyDuration(seq);
  if (duration < MIN_CLIP_DURATION) return fail(`“${seq.name}” is empty — add clips to it first.`);
  const base = videoTracks(state.tracks)[0];
  if (!base) return fail('The timeline has no video lane.');
  if (base.locked) return fail(lockedReason(base));
  const clip = createSequenceClip(seq, duration, clipId);
  const clips = [...state.clips, clip];
  const tracks = state.tracks.map((track) =>
    track.id === base.id
      ? { ...track, items: [...track.items, { clipId: clip.id, startTime: computeTrackEnd(track, state.clips) }] }
      : track,
  );
  return ok({ ...state, clips, tracks: normalizeBaseLane(tracks, clips, state.transitions) });
}

export interface NestRequest {
  /** Clips to move into the new sequence (any lanes of the open timeline). */
  clipIds: string[];
  /** Text overlays to move with them (their titles-lane placements follow). */
  textOverlayIds?: string[];
  sequenceId: string;
  name: string;
  /** Id for the sequence clip that replaces them. */
  sequenceClipId?: string;
}

/**
 * Move clips (and titles) into a new sequence and put one sequence clip
 * where they were.
 *
 * - Main-lane clips must be one continuous run; the sequence clip takes the
 *   run's slot, and the run's inner transitions move with it (the ones on
 *   its edges now join the sequence clip).
 * - Overlay and audio clips keep their lane and their offset from the
 *   window's start (the run's start, else the earliest selected clip).
 * - A/B groups move whole. Locked lanes refuse.
 */
export function nestClips(state: SequenceEditorState, request: NestRequest): SequenceEditResult {
  const selected = new Set(request.clipIds);
  const overlayIds = new Set(request.textOverlayIds ?? []);
  const byId = new Map(state.clips.map((clip) => [clip.id, clip]));
  const placed = state.tracks.flatMap((track) =>
    track.kind === 'text' ? [] : track.items.filter((item) => selected.has(item.clipId)).map((item) => ({ track, item })),
  );
  if (placed.length === 0) return fail('Select clips on the timeline to nest.');
  const titleLanes = state.tracks.filter(
    (track) => track.kind === 'text' && track.items.some((item) => overlayIds.has(item.clipId)),
  );
  const locked = [...placed.map((p) => p.track), ...titleLanes].find((track) => track.locked);
  if (locked) return fail(lockedReason(locked));
  if (!placed.some(({ item }) => byId.get(item.clipId)?.kind === 'video')) {
    return fail('Nest at least one video clip — a sequence clip is a picture.');
  }

  const base = videoTracks(state.tracks)[0];
  const order = baseLaneOrder(state.tracks);
  const runIndices = order.map((id, i) => (selected.has(id) ? i : -1)).filter((i) => i >= 0);
  const runStart = runIndices[0] ?? -1;
  const runEnd = runIndices[runIndices.length - 1] ?? -1;
  if (runIndices.length > 0 && runEnd - runStart + 1 !== runIndices.length) {
    return fail('Nest a continuous run of clips on the main lane.');
  }

  const startOf = (clipId: string) => placed.find((p) => p.item.clipId === clipId)?.item.startTime ?? 0;
  const windowStart =
    runStart >= 0 ? startOf(order[runStart]!) : Math.min(...placed.map(({ item }) => item.startTime));

  // Groups move whole, inactive variants included.
  const groups = state.clipGroups.filter((group) =>
    [group.variants.A, group.variants.B].some((variant) => variant && selected.has(variant.id)),
  );
  const moving = new Set(selected);
  for (const group of groups) {
    for (const variant of [group.variants.A, group.variants.B]) if (variant) moving.add(variant.id);
  }

  // ── The new sequence ──
  const nestedTracks: Track[] = state.tracks
    .filter(
      (track) =>
        track.id === base?.id ||
        track.items.some((item) => moving.has(item.clipId) || (track.kind === 'text' && overlayIds.has(item.clipId))),
    )
    .map((track) => {
      const { audioFx: _fx, duck: _duck, locked: _locked, ...lane } = cloneTrack(track);
      return {
        ...lane,
        items: lane.items
          .filter((item) => (track.kind === 'text' ? overlayIds.has(item.clipId) : moving.has(item.clipId)))
          .map((item) => ({ clipId: item.clipId, startTime: Math.max(0, item.startTime - windowStart) })),
      };
    });
  const nestedClips = state.clips.filter((clip) => moving.has(clip.id));
  const innerTransitions: ClipTransition[] =
    runStart >= 0
      ? state.transitions
          .filter((t) => t.afterClipIndex > runStart && t.afterClipIndex <= runEnd)
          .map((t) => ({ ...t, afterClipIndex: t.afterClipIndex - runStart }))
      : [];
  const nestedOverlays: TextOverlay[] = state.textOverlays.filter((overlay) => overlayIds.has(overlay.id));
  const nestedBody: SequenceBody = {
    tracks: normalizeBaseLane(nestedTracks, nestedClips, innerTransitions),
    clips: nestedClips,
    clipGroups: groups,
    transitions: innerTransitions,
    textOverlays: nestedOverlays,
  };
  const sequence: Sequence = { id: request.sequenceId, name: request.name, ...nestedBody };
  const seqClip = createSequenceClip(sequence, sequenceBodyDuration(nestedBody), request.sequenceClipId);

  // ── The parent ──
  const overlayLane = placed.find(({ track }) => track.kind === 'video' && track.id !== base?.id)?.track;
  const hostLaneId = runStart >= 0 ? base?.id : overlayLane?.id;
  if (!hostLaneId) return fail('Nest at least one video clip — a sequence clip is a picture.');
  const tracks = state.tracks.map((track) => {
    const items = track.items.filter((item) =>
      track.kind === 'text' ? !overlayIds.has(item.clipId) : !moving.has(item.clipId),
    );
    if (track.id === hostLaneId) items.push({ clipId: seqClip.id, startTime: windowStart });
    return items.length === track.items.length && track.id !== hostLaneId ? track : { ...track, items };
  });
  const firstMoved = state.clips.findIndex((clip) => moving.has(clip.id));
  const remaining = state.clips.filter((clip) => !moving.has(clip.id));
  const clips = [...remaining.slice(0, firstMoved), seqClip, ...remaining.slice(firstMoved)];
  const removed = runIndices.length - 1;
  const transitions =
    runStart >= 0
      ? state.transitions
          .filter((t) => t.afterClipIndex <= runStart || t.afterClipIndex > runEnd)
          .map((t) => (t.afterClipIndex > runEnd ? { ...t, afterClipIndex: t.afterClipIndex - removed } : t))
      : state.transitions;
  const clipGroups: ClipGroup[] = state.clipGroups.filter((group) => !groups.includes(group));

  const committed = toCommitted({
    ...state,
    tracks: normalizeBaseLane(tracks, clips, transitions),
    clips,
    clipGroups,
    transitions,
    textOverlays: state.textOverlays.filter((overlay) => !overlayIds.has(overlay.id)),
  });
  return ok(fromCommitted({ ...committed, sequences: [...committed.sequences, sequence] }));
}
