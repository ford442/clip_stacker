import type { SerializedClip, SerializedClipGroup, SyncMarker } from './clip';
import type { CaptionEntry, TextOverlay, TextOverlayStyle } from './text';
import type { SerializedTrack } from './track';
import type { SerializedTransition } from './transition';

/** Current on-disk project schema. Absent / 0 = legacy flat clip list. */
export const PROJECT_SCHEMA_VERSION = 2;

/** External reference music track for lip-sync visual anchoring (serialized). */
export interface SerializedMasterAudio {
  fileName: string;
  duration: number;
  /** Timeline offset in seconds (default 0). */
  startTime?: number;
  fileType?: string;
  /** Embedded bytes for local project portability. */
  sourceMediaDataUrl?: string;
  /** Remote URL for remote project portability. */
  sourceMediaUrl?: string;
  /** Detected beat onset times in seconds from the start of the audio file. */
  beatTimestamps?: number[];
  /** BPM estimate from `beatTimestamps`. */
  bpmEstimate?: number;
  /** 0–1 confidence in `bpmEstimate`. */
  bpmConfidence?: number;
}

/** Runtime master audio reference (loaded MP3 / WAV for sync UI). */
export interface MasterAudio {
  file: File;
  objectUrl: string;
  fileName: string;
  duration: number;
  /** Timeline offset in seconds. */
  startTime: number;
  /**
   * Detected beat onset times in seconds from the start of the audio file
   * (add `startTime` for timeline seconds). Populated by offline analysis.
   */
  beatTimestamps?: number[];
  /** BPM estimate from `beatTimestamps`. */
  bpmEstimate?: number;
  /** 0–1 confidence in `bpmEstimate`. */
  bpmConfidence?: number;
}

export interface Project {
  /** Project schema version. Omitted = legacy (pre-track) format. */
  schemaVersion?: number;
  /** Timeline tracks (schema v1+). */
  tracks?: SerializedTrack[];
  clips: SerializedClip[];
  clipGroups?: SerializedClipGroup[];
  transitions?: SerializedTransition[];
  textOverlays?: TextOverlay[];
  /**
   * Time-coded caption cues. Optional so projects saved before captions
   * existed still parse; treated as an empty track when absent.
   */
  captions?: CaptionEntry[];
  /** Project-wide caption style; per-cue `style` overrides win over this. */
  captionStyle?: Partial<TextOverlayStyle>;
  /**
   * Output resolution used when layout coordinates were saved as pixels (schema v1).
   * Schema v2 stores normalized coordinates; this field documents the migration source.
   */
  layoutReferenceResolution?: string;
  /** Final-stage 3D LUT color grade applied on the WebGPU export path. @deprecated Use `finishing.lut`. */
  colorGrade?: import('../utils/lut').ColorGradeSettings;
  /** Ordered finishing pass chain (noise → primary → secondary → LUT → sharpen → grain). */
  finishing?: import('../utils/finishing').FinishingSettings;
  /**
   * Output color and working space. Omitted when both are the Rec.709 SDR
   * default, so older projects load unchanged.
   */
  colorManagement?: import('../utils/colorManagement').ColorManagementSettings;
  /**
   * How source media was stored when this project was saved. Used on load
   * to pick between `sourceMediaDataUrl` and `sourceMediaUrl` authoritatively,
   * rather than falling back through whichever happens to be present (a
   * project re-saved in a different mode may still carry a stale field from
   * an earlier save).
   */
  mediaMode?: 'metadata' | 'embed' | 'remote';
  /** External music reference for lip-sync (visual anchor + export scratch track). */
  masterAudio?: SerializedMasterAudio;
  /** Global anchor points for text-based sync */
  masterAudioMarkers?: SyncMarker[];
}
