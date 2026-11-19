import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  MasterAudio,
  Sequence,
  TextOverlay,
  TextOverlayStyle,
  Track,
  SyncMarker,
} from '../types';
import type { ColorGradeSettings } from '../finishing/lut';
import type { FinishingSettings } from '../finishing/finishing';
import type { ColorManagementSettings } from '../finishing/colorManagement';

export interface RemoteUploadProgressEvent {
  clipId: string;
  fileName: string;
  index: number;
  total: number;
  progress: number;
  status: 'uploading' | 'uploaded' | 'failed' | 'skipped';
  message?: string;
  /** Present when the active upload is using the chunked path. */
  chunkIndex?: number | undefined;
  chunkTotal?: number;
}

export interface RemoteUploadErrorEvent extends RemoteUploadProgressEvent {
  error: Error;
  attempt: number;
  status: 'failed';
}

export interface AppliedProjectData {
  /** The main timeline's clips. */
  clips: Clip[];
  /** Nested sequences (empty for projects saved before they existed). */
  sequences: Sequence[];
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  /** Caption cues restored from the project (empty when it predates captions). */
  captions: CaptionEntry[];
  /** Project-wide caption style overrides (empty when unset). */
  captionStyle: Partial<TextOverlayStyle>;
  masterAudio: MasterAudio | null;
  masterAudioMarkers: SyncMarker[];
  /** Master bus FX / loudness target; undefined when the project has none. */
  masterBus: import('../audio/audioBus').MasterBusSettings | undefined;
  colorGrade: ColorGradeSettings;
  finishing: FinishingSettings;
  colorManagement: ColorManagementSettings;
  skippedClipCount: number;
  skippedClipFileNames: string[];
  /** Clips that loaded offline (no media): they keep their place until relinked. */
  offlineClipFileNames: string[];
  /** The project's timecode start and rate (defaults when it saved none). */
  timecode: import('../types').ProjectTimecode;
  /** Human-readable descriptions of invalid color values that were reset to defaults. */
  invalidColorWarnings: string[];
  /** Human-readable reasons remote media could not be downloaded, one per failed clip. */
  mediaDownloadWarnings: string[];
}

export interface RemoteProjectLoadProgressEvent {
  stage: string;
  progress: number | null;
  indeterminate: boolean;
  clipIndex?: number;
  clipCount?: number;
  fileName?: string;
}

export interface ApplyProjectDataOptions {
  onProgress?: ((event: RemoteProjectLoadProgressEvent) => void) | undefined;
  /**
   * What happens to a clip whose media cannot be found: `skip` (default)
   * drops it; `offline` keeps it as an offline clip. A clip saved offline
   * always loads offline when its media is still missing.
   */
  missingMedia?: 'skip' | 'offline';
  /**
   * Resolve each media clip's file yourself (an imported timeline's relink).
   * Each saved clip then gets its own loaded clip with its saved id; the
   * live-clip-by-name match is not used. Null = not found.
   */
  resolveMedia?: ((saved: import('../types').SerializedClip) => Promise<File | null> | File | null) | undefined;
  remoteProgressStart?: number;
  remoteProgressEnd?: number;
}

export interface LoadRemoteProjectOptions {
  onProgress?: (event: RemoteProjectLoadProgressEvent) => void;
  missingMedia?: ApplyProjectDataOptions['missingMedia'];
}

/** A single entry in the remote media library, as returned by `listMedia`. */
export interface MediaLibraryItem {
  /** Storage object name (e.g. "clip1-vacation.mp4"). */
  name: string;
  /** Public/signed URL the file can be downloaded from. */
  url: string;
  /** File size in bytes, if reported by the server. */
  size?: number;
  /** Last-modified time as a Unix timestamp (seconds), if reported by the server. */
  modified?: number;
}
