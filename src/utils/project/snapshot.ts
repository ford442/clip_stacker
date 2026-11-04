import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  MasterAudio,
  SyncMarker,
  TextOverlay,
  TextOverlayStyle,
  Track,
} from '../../types';
import { DEFAULT_FINISHING, type FinishingSettings } from '../finishing';
import {
  DEFAULT_COLOR_MANAGEMENT,
  type ColorManagementSettings,
} from '../colorManagement';
import type { MasterBusSettings } from '../audioBus';

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
>;

/** The settings-store fields a snapshot reads. */
export type ProjectSnapshotSettingsFields = Pick<
  ProjectSnapshot,
  'finishing' | 'colorManagement'
>;

/**
 * The editor-store half of a snapshot, field identities kept — wrap it in
 * `useShallow` to re-render only when a saved field changes.
 */
export function selectProjectSnapshotEditorFields(
  editor: ProjectSnapshotEditorFields,
): ProjectSnapshotEditorFields {
  return {
    clips: editor.clips,
    tracks: editor.tracks,
    clipGroups: editor.clipGroups,
    transitions: editor.transitions,
    textOverlays: editor.textOverlays,
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
  editor: ProjectSnapshotEditorFields,
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
    snapshot.masterAudioMarkers.length > 0
  );
}
