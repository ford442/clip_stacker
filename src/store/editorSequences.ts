import type { Sequence, SequenceBody } from '../types';
import {
  createSequence as createSequenceIn,
  deleteSequence as deleteSequenceIn,
  enterSequence as enterSequenceIn,
  exitSequence as exitSequenceIn,
  exitToRoot,
  nestClips as nestClipsIn,
  placeSequence as placeSequenceIn,
  renameSequence as renameSequenceIn,
  type NestRequest,
  type SequenceEditResult,
  type SequenceEditorState,
} from '../timeline/sequenceModel';
import { createClipId } from '../media/media';

/**
 * Nested-sequence actions of the editor store (`editorStore.ts` spreads
 * these in). Each returns `null` on success or the reason it was refused —
 * the UI shows the reason; nothing throws.
 *
 * Edits that change the graph (nest, place, create, rename, delete) are one
 * undo step each. Entering and leaving a sequence is navigation and pushes
 * none: undo restores whichever sequence the restored state was edited in.
 */
export interface EditorSequenceActions {
  /** Nested sequences (see `timeline/sequenceModel.ts`; the open one's entry is stale). */
  sequences: Sequence[];
  /** Open sequences, outermost first; `[]` = editing the main timeline. */
  sequencePath: string[];
  /** The main timeline's body while a nested sequence is open. */
  rootStash: SequenceBody | null;

  /** Open a sequence for editing (breadcrumb push). */
  enterSequence: (sequenceId: string) => string | null;
  /** Back to the parent; sequence clips take the edited sequence's length. */
  exitSequence: () => string | null;
  /** Back to the main timeline from any depth. */
  exitToRootSequence: () => void;
  /** Move clips (and titles) into a new sequence placed where they were. */
  nestClips: (request: Omit<NestRequest, 'sequenceId' | 'name'> & { name?: string }) => string | null;
  /** Place a sequence at the end of the open timeline's main lane. */
  placeSequence: (sequenceId: string) => string | null;
  /** Create an empty sequence and open it. Returns its id. */
  createSequence: (name?: string) => string;
  renameSequence: (sequenceId: string, name: string) => string | null;
  deleteSequence: (sequenceId: string) => string | null;
}

type Get = () => SequenceEditorState & { selectedClipId: string | null };
type Set = (patch: Partial<SequenceEditorState> & { selectedClipId?: string | null }) => void;

const SEQUENCE_ID_PREFIX = 'seq-';

/** "Sequence N" for the first N not taken. */
function nextSequenceName(sequences: Sequence[]): string {
  const taken = new Set(sequences.map((seq) => seq.name));
  for (let n = sequences.length + 1; ; n++) {
    const name = `Sequence ${n}`;
    if (!taken.has(name)) return name;
  }
}

function sequenceFields(state: SequenceEditorState): SequenceEditorState {
  return {
    tracks: state.tracks,
    clips: state.clips,
    clipGroups: state.clipGroups,
    transitions: state.transitions,
    textOverlays: state.textOverlays,
    sequences: state.sequences,
    sequencePath: state.sequencePath,
    rootStash: state.rootStash,
  };
}

export function createEditorSequenceActions(
  get: Get,
  set: Set,
  pushHistory: () => void,
): Omit<EditorSequenceActions, 'sequences' | 'sequencePath' | 'rootStash'> {
  /** Apply a result; `undoable` pushes one history step first. */
  const apply = (result: SequenceEditResult, undoable: boolean, keepSelection = false): string | null => {
    if (!result.ok) return result.reason;
    if (undoable) pushHistory();
    const selected = get().selectedClipId;
    const stillThere = selected !== null && result.state.clips.some((clip) => clip.id === selected);
    set({ ...sequenceFields(result.state), selectedClipId: keepSelection && stillThere ? selected : null });
    return null;
  };

  return {
    enterSequence: (sequenceId) => apply(enterSequenceIn(get(), sequenceId), false),
    exitSequence: () => apply(exitSequenceIn(get()), false),
    exitToRootSequence: () => {
      const state = get();
      if (state.sequencePath.length === 0) return;
      set({ ...sequenceFields(exitToRoot(state)), selectedClipId: null });
    },
    nestClips: (request) => {
      const state = get();
      const sequenceClipId = request.sequenceClipId ?? createClipId();
      const result = nestClipsIn(state, {
        ...request,
        sequenceId: `${SEQUENCE_ID_PREFIX}${createClipId()}`,
        name: request.name ?? nextSequenceName(state.sequences),
        sequenceClipId,
      });
      const refused = apply(result, true);
      if (refused === null) set({ selectedClipId: sequenceClipId });
      return refused;
    },
    placeSequence: (sequenceId) => apply(placeSequenceIn(get(), sequenceId), true, true),
    createSequence: (name) => {
      const state = get();
      const id = `${SEQUENCE_ID_PREFIX}${createClipId()}`;
      const created = createSequenceIn(state, { id, name: name?.trim() || nextSequenceName(state.sequences) });
      apply(created, true, true);
      apply(enterSequenceIn(get(), id), false);
      return id;
    },
    renameSequence: (sequenceId, name) => apply(renameSequenceIn(get(), sequenceId, name), true, true),
    deleteSequence: (sequenceId) => apply(deleteSequenceIn(get(), sequenceId), true, true),
  };
}
