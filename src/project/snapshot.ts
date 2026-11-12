import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  MasterAudio,
  Sequence,
  SequenceBody,
  SyncMarker,
  TextOverlay,
  TextOverlayStyle,
  Track,
} from '../types';
import { DEFAULT_FINISHING, type FinishingSettings } from '../finishing/finishing';
import {
  DEFAULT_COLOR_MANAGEMENT,
  type ColorManagementSettings,
} from '../finishing/colorManagement';
import type { MasterBusSettings } from '../audio/audioBus';
import { committedSequences, type SequenceEditorState } from '../timeline/sequenceModel';

/**
 * Everything a saved project contains, read from the stores in one place.
 *
 * Manual save, remote save, autosave and the autosave change hash all go
 * through this, so a new piece of project state is added here once instead of
 * at every call site (autosave used to drop finishing and master audio because
 * each caller picked its own subset of positional arguments).
 *
 * Every field is required on purpose: a caller that builds a snapshot by hand
 * has to say what it leaves empty. Tests use {@link createProjectSnapshot}.
 */
export interface ProjectSnapshot {
  /** The main timeline's clips (nested sequences hold their own). */
  clips: Clip[];
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  captions: CaptionEntry[];
  captionStyle: Partial<TextOverlayStyle>;
  masterAudio: MasterAudio | null;
  masterAudioMarkers: SyncMarker[];
  masterBus: MasterBusSettings | undefined;
  finishing: FinishingSettings;
  colorManagement: ColorManagementSettings;
  /** Nested sequences, live edits of an open one included. */
  sequences: Sequence[];
}

/** The editor-store fields a snapshot reads (structural, so no store import). */
export type ProjectSnapshotEditorFields = Pick<
  ProjectSnapshot,
  | 'clips'
  | 'tracks'
  | 'clipGroups'
  | 'transitions'
  | 'textOverlays'
  | 'captions'
  | 'captionStyle'
  | 'masterAudio'
  | 'masterAudioMarkers'
  | 'masterBus'
  | 'sequences'
>;

/** Editor state a snapshot is read from: the open sequence may be a nested one. */
type EditorSnapshotSource = ProjectSnapshotEditorFields & {
  sequencePath?: string[];
  rootStash?: SequenceBody | null;
};

/** The settings-store fields a snapshot reads. */
export type ProjectSnapshotSettingsFields = Pick<
  ProjectSnapshot,
  'finishing' | 'colorManagement'
>;

/**
 * The editor-store half of a snapshot, field identities kept — wrap it in
 * `useShallow` to re-render only when a saved field changes. While a nested
 * sequence is open, the root fields come from the stashed main timeline and
 * the open sequence's live edits are written into `sequences`, so a save
 * from inside a sequence is the whole project.
 */
export function selectProjectSnapshotEditorFields(
  editor: EditorSnapshotSource,
): ProjectSnapshotEditorFields {
  const open = (editor.sequencePath?.length ?? 0) > 0 && editor.rootStash ? editor.rootStash : null;
  const root = open ?? editor;
  return {
    clips: root.clips,
    tracks: root.tracks,
    clipGroups: root.clipGroups,
    transitions: root.transitions,
    textOverlays: root.textOverlays,
    sequences: open ? committedSequences(editor as SequenceEditorState) : editor.sequences,
    captions: editor.captions,
    captionStyle: editor.captionStyle,
    masterAudio: editor.masterAudio,
    masterAudioMarkers: editor.masterAudioMarkers,
    masterBus: editor.masterBus,
  };
}

/**
 * The one projection of store state onto a saved project. Field identities
 * are kept (nothing is copied), so the result can feed a shallow selector.
 */
export function selectProjectSnapshot(
  editor: EditorSnapshotSource,
  settings: ProjectSnapshotSettingsFields,
): ProjectSnapshot {
  return {
    ...selectProjectSnapshotEditorFields(editor),
    finishing: settings.finishing,
    colorManagement: settings.colorManagement,
  };
}

/** A snapshot with every omitted field at its empty default. */
export function createProjectSnapshot(
  partial: Partial<ProjectSnapshot> = {},
): ProjectSnapshot {
  return {
    clips: [],
    tracks: [],
    clipGroups: [],
    transitions: [],
    textOverlays: [],
    captions: [],
    captionStyle: {},
    masterAudio: null,
    masterAudioMarkers: [],
    masterBus: undefined,
    finishing: DEFAULT_FINISHING,
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
    sequences: [],
    ...partial,
  };
}

/**
 * True when the snapshot holds work worth keeping. Grade, colour and bus
 * settings alone do not count — they are settings, not content — but a
 * project with only captions or only a master track does.
 */
export function projectSnapshotHasContent(snapshot: ProjectSnapshot): boolean {
  return (
    snapshot.clips.length > 0 ||
    snapshot.transitions.length > 0 ||
    snapshot.textOverlays.length > 0 ||
    snapshot.captions.length > 0 ||
    snapshot.masterAudio != null ||
    snapshot.masterAudioMarkers.length > 0 ||
    snapshot.sequences.length > 0
  );
}

/** Every clip the snapshot holds — the main timeline's and each sequence's. */
export function projectSnapshotClips(snapshot: Pick<ProjectSnapshot, 'clips' | 'sequences'>): Clip[] {
  if (snapshot.sequences.length === 0) return snapshot.clips;
  return [...snapshot.clips, ...snapshot.sequences.flatMap((seq) => seq.clips)];
}
