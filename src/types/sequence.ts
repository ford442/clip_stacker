import type { Clip, ClipGroup } from './clip';
import type { TextOverlay } from './text';
import type { SerializedTrack, Track } from './track';
import type { ClipTransition, SerializedTransition } from './transition';

/**
 * Nested sequences (compound clips).
 *
 * A sequence is a timeline of its own — lanes, clips, base-lane transitions
 * and titles — that a parent timeline places as one clip. The root timeline
 * is the implicit sequence: its body is the editor's top-level fields, so a
 * project without nested sequences is exactly what it was before.
 *
 * Captions, finishing, colour management, the master track and the master
 * bus stay project-wide (root only).
 */

/** What a sequence holds — the same shape the editor edits for the root. */
export interface SequenceBody {
  tracks: Track[];
  /** The clips this sequence's lanes place (a clip belongs to one sequence). */
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
}

/** A nested (non-root) sequence. */
export interface Sequence extends SequenceBody {
  id: string;
  name: string;
}

/**
 * A nested sequence on disk. Its clips stay in the project's shared
 * `clips` pool (so media embedding / upload / autosave treat them like any
 * other clip) and are claimed here by id. A client that predates sequences
 * ignores this field and loads the pool flat.
 */
export interface SerializedSequence {
  id: string;
  name: string;
  clipIds: string[];
  tracks?: SerializedTrack[];
  transitions?: SerializedTransition[];
  textOverlays?: TextOverlay[];
}
