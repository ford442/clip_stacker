import type { Clip, ClipGroup, ClipTransition, TextOverlay, Track } from '../../types';
import type { ColorGradeSettings } from '../lut';
import type { FinishingSettings } from '../finishing';

export interface RemoteUploadProgressEvent {
  clipId: string;
  fileName: string;
  index: number;
  total: number;
  progress: number;
  status: 'uploading' | 'uploaded' | 'failed' | 'skipped';
  message?: string;
  /** Present when the active upload is using the chunked path. */
  chunkIndex?: number;
  chunkTotal?: number;
}

export interface RemoteUploadErrorEvent extends RemoteUploadProgressEvent {
  error: Error;
  attempt: number;
  status: 'failed';
}

export interface AppliedProjectData {
  clips: Clip[];
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  colorGrade: ColorGradeSettings;
  finishing: FinishingSettings;
  skippedClipCount: number;
  skippedClipFileNames: string[];
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
  onProgress?: (event: RemoteProjectLoadProgressEvent) => void;
  remoteProgressStart?: number;
  remoteProgressEnd?: number;
}

export interface LoadRemoteProjectOptions {
  onProgress?: (event: RemoteProjectLoadProgressEvent) => void;
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
