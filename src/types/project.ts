import type { SerializedClip, SerializedClipGroup, SyncMarker } from './clip';
import type { CaptionEntry, TextOverlay, TextOverlayStyle } from './text';
import type { SerializedSequence } from './sequence';
import type { SerializedTrack } from './track';
import type { SerializedTransition } from './transition';

/**
 * Current on-disk project schema. Absent / 0 = legacy flat clip list;
 * 2 = normalized layout coordinates; 3 = nested sequences (`sequences`).
 */
export const PROJECT_SCHEMA_VERSION = 3;

/** First schema that stores layout as fractions of the output (not pixels). */
export const NORMALIZED_LAYOUT_SCHEMA_VERSION = 2;

/**
 * Timecode / sequence rates timeline interchange is written at
 * (`interchange/timecode.ts`). `30` is the export grid.
 */
export type TimecodeRateId =
  | '23.976'
  | '24'
  | '25'
  | '29.97'
  | '29.97df'
  | '30'
  | '50'
  | '59.94'
  | '59.94df'
  | '60';

/** Where frame 0 of the timeline sits in timecode (EDL, OTIO, FCPXML, BWF stems). */
export interface ProjectTimecode {
  /** `HH:MM:SS:FF` (`;` before the frames for drop frame). Default `01:00:00:00`. */
  start: string;
  rate: TimecodeRateId;
}

export const DEFAULT_PROJECT_TIMECODE: ProjectTimecode = { start: '01:00:00:00', rate: '30' };

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
  colorGrade?: import('../finishing/lut').ColorGradeSettings;
  /** Ordered finishing pass chain (noise → primary → secondary → LUT → sharpen → grain). */
  finishing?: import('../finishing/finishing').FinishingSettings;
  /**
   * Output color and working space. Omitted when both are the Rec.709 SDR
   * default, so older projects load unchanged.
   */
  colorManagement?: import('../finishing/colorManagement').ColorManagementSettings;
  /**
   * How source media was stored when this project was saved. Used on load
   * to pick between `sourceMediaDataUrl` and `sourceMediaUrl` authoritatively,
   * rather than falling back through whichever happens to be present (a
   * project re-saved in a different mode may still carry a stale field from
   * an earlier save).
   */
  mediaMode?: 'metadata' | 'embed' | 'remote';
  /**
   * Master bus: FX after the lanes are summed, and the export loudness
   * target. Omitted on projects without either (they mix as before).
   */
  masterBus?: import('../audio/audioBus').MasterBusSettings;
  /** External music reference for lip-sync (visual anchor + export scratch track). */
  masterAudio?: SerializedMasterAudio;
  /** Global anchor points for text-based sync */
  masterAudioMarkers?: SyncMarker[];
  /**
   * Nested sequences (schema v3). The top-level `tracks` / `transitions` /
   * `textOverlays` are the root sequence; omitted when there are none.
   */
  sequences?: SerializedSequence[];
  /**
   * Timecode of the timeline's first frame (`HH:MM:SS:FF`). Omitted = the
   * default `01:00:00:00`, so older projects load unchanged.
   */
  timecodeStart?: string;
  /** Rate interchange and BWF stems count frames at. Omitted = `30`. */
  timecodeRate?: TimecodeRateId;
}
