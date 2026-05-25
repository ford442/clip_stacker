export type ClipKind = 'video' | 'audio';

export interface Clip {
  id: string;
  file: File;
  objectUrl: string;
  title: string;
  kind: ClipKind;
  duration: number;
  trimStart: number;
  trimEnd: number; // NaN means "use full duration"
  videoFadeIn: number;
  videoFadeOut: number;
  audioFadeIn: number;
  audioFadeOut: number;
  inputName?: string;
  /** Group ID for A/B comparison */
  groupId?: string;
  /** Which variant slot this clip occupies within its group */
  groupVariant?: 'A' | 'B';
  /** URL of the remotely stored extracted WAV for this clip */
  remoteAudioUrl?: string;
}

export interface SerializedClip {
  id: string;
  title: string;
  kind: ClipKind;
  duration: number;
  trimStart: number;
  trimEnd: number | null;
  videoFadeIn: number;
  videoFadeOut: number;
  audioFadeIn: number;
  audioFadeOut: number;
  fileName: string;
  /** URL of the remotely stored extracted WAV for this clip */
  remoteAudioUrl?: string;
}

export type TransitionType = 'none' | 'dissolve' | 'motion';

/** Defines the transition between clip[index-1] and clip[index] in the timeline. */
export interface ClipTransition {
  /** The clip index at whose *start* this transition occurs (≥ 1). */
  afterClipIndex: number;
  type: TransitionType;
  /** Overlap duration in seconds (0 for hard cut). */
  duration: number;
}

export interface SerializedTransition {
  afterClipIndex: number;
  type: TransitionType;
  duration: number;
}

/** A group of up to two variants (A = original, B = edited) for A/B comparison. */
export interface ClipGroup {
  id: string;
  /** Clips keyed by slot. */
  variants: Record<'A' | 'B', Clip | null>;
  /** Which variant is currently active on the timeline. */
  activeVariant: 'A' | 'B';
}

/** Quality settings forwarded to the FFmpeg (or WebCodecs) encode path. */
export interface ExportSettings {
  /** H.264 CRF value (0–51; lower = higher quality). Default 18. */
  crf: number;
  /** libx264 preset. Default 'medium'. */
  preset: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
  /** Target video bitrate in bits/s for the WebCodecs path (0 = auto). */
  videoBitrate: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  crf: 18,
  preset: 'medium',
  videoBitrate: 8_000_000,
};

export interface Project {
  clips: SerializedClip[];
  transitions?: SerializedTransition[];
}
