import type { Clip, ClipGroup, ClipTransition, Sequence, SequenceBody, TextOverlay, Track } from '../types';
import { getEffectiveTimelineClips } from '../timeline/trackModel';
import { resolveNestedSequences } from '../composition/nestedSequences';
import { activeSequenceId, sequenceBodies } from '../timeline/sequenceModel';

/** The editor fields the timeline-clip derivation reads. */
export interface TimelineClipInputs {
  tracks: Track[];
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions?: ClipTransition[];
  textOverlays?: TextOverlay[];
  /** Nested sequences (omitted = none). */
  sequences?: Sequence[];
  sequencePath?: string[];
  rootStash?: SequenceBody | null;
}

const NO_TRANSITIONS: ClipTransition[] = [];
const NO_OVERLAYS: TextOverlay[] = [];

let memo: {
  tracks: Track[];
  clips: Clip[];
  clipGroups: ClipGroup[];
  bodies: ReadonlyMap<string, SequenceBody> | null;
  active: string | null;
  result: Clip[];
} | null = null;

/**
 * The clips on the timeline (active A/B variant per group, track order, with
 * the derived placement fields stamped on, and every sequence clip's nested
 * sequence resolved onto `Clip.nested`) — the one derivation every caller
 * uses. Memoized on the identity of its inputs, so the store hook, the
 * action hooks and `getState()` readers share one array per edit.
 */
export function selectTimelineClips(state: TimelineClipInputs): Clip[] {
  const sequences = state.sequences ?? [];
  const sequencePath = state.sequencePath ?? [];
  const nested = sequences.length > 0
    ? {
        tracks: state.tracks,
        clips: state.clips,
        clipGroups: state.clipGroups,
        transitions: state.transitions ?? NO_TRANSITIONS,
        textOverlays: state.textOverlays ?? NO_OVERLAYS,
        sequences,
        sequencePath,
        rootStash: state.rootStash ?? null,
      }
    : null;
  const bodies = nested ? sequenceBodies(nested) : null;
  const active = activeSequenceId({ sequencePath });
  if (
    memo &&
    memo.tracks === state.tracks &&
    memo.clips === state.clips &&
    memo.clipGroups === state.clipGroups &&
    memo.bodies === bodies &&
    memo.active === active
  ) {
    return memo.result;
  }
  const flat = getEffectiveTimelineClips(state.tracks, state.clips, state.clipGroups);
  const result = bodies ? resolveNestedSequences(flat, bodies, active) : flat;
  memo = { tracks: state.tracks, clips: state.clips, clipGroups: state.clipGroups, bodies, active, result };
  return result;
}
