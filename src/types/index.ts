export type ClipKind = 'video' | 'audio';

export interface Clip {
  id: string;
  file: File;
  objectUrl: string;
  title: string;
  kind: ClipKind;
  duration: number;
  /** Native video width in pixels (video clips only). */
  videoWidth?: number;
  /** Native video height in pixels (video clips only). */
  videoHeight?: number;
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
  // ---------------------------------------------------------------------------
  // RIFE frame interpolation metadata
  // ---------------------------------------------------------------------------
  /** Whether this clip has been processed with RIFE frame interpolation */
  rifeProcessed?: boolean;
  /** The frame-rate multiplier used (e.g. 2 = 2×, 4 = 4×) */
  rifeMultiplier?: number;
  /** Original FPS of the clip before RIFE processing */
  originalFps?: number;
  /** FPS of the clip after RIFE processing */
  processedFps?: number;
  /** RIFE processing mode applied to this clip */
  rifeMode?: 'interpolation' | 'boomerang';
  // ---------------------------------------------------------------------------
  // Picture-in-Picture / compositing layout (only used when layerIndex > 0)
  // ---------------------------------------------------------------------------
  /** Stacking order: 0 = base layer (sequential), 1+ = overlay on top of base. */
  layerIndex?: number;
  /** Overlay X position in pixels from the top-left of the output canvas. */
  x?: number;
  /** Overlay Y position in pixels from the top-left of the output canvas. */
  y?: number;
  /** Overlay width in pixels; 0 means preserve the original clip width. */
  width?: number;
  /** Overlay height in pixels; 0 means preserve the original clip height. */
  height?: number;
  /** Overlay opacity from 0.0 (transparent) to 1.0 (fully opaque). */
  opacity?: number;
  /** Overlay audio volume multiplier (0 = muted, 1 = unchanged, 2 = double). */
  volume?: number;
}

export interface SerializedClip {
  id: string;
  title: string;
  kind: ClipKind;
  duration: number;
  videoWidth?: number;
  videoHeight?: number;
  trimStart: number;
  trimEnd: number | null;
  videoFadeIn: number;
  videoFadeOut: number;
  audioFadeIn: number;
  audioFadeOut: number;
  fileName: string;
  /** MIME type of the original source media file (if known) */
  fileType?: string;
  /** Data URL containing the source media bytes for local project portability */
  sourceMediaDataUrl?: string;
  /** Remote URL containing the source media bytes for remote project portability */
  sourceMediaUrl?: string;
  /** Group ID for A/B comparison */
  groupId?: string;
  /** Which variant slot this clip occupies within its group */
  groupVariant?: 'A' | 'B';
  /** URL of the remotely stored extracted WAV for this clip */
  remoteAudioUrl?: string;
  /** Whether this clip has been processed with RIFE frame interpolation */
  rifeProcessed?: boolean;
  /** The frame-rate multiplier used (e.g. 2 = 2×, 4 = 4×) */
  rifeMultiplier?: number;
  /** Original FPS of the clip before RIFE processing */
  originalFps?: number;
  /** FPS of the clip after RIFE processing */
  processedFps?: number;
  /** RIFE processing mode applied to this clip */
  rifeMode?: 'interpolation' | 'boomerang';
  /** PiP / compositing layout properties */
  layerIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  volume?: number;
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
  /** Output filename (without extension; .mp4 is automatically appended). */
  filename: string;
  /** Output resolution as WIDTHxHEIGHT, or 'original' to preserve the existing auto path. */
  outputResolution: string;
  /** Common output-size preset selected in the export UI. */
  resolutionPreset?: ResolutionPreset;
}

export type ResolutionPreset = 'original' | '720p' | '1080p' | '1440p' | '4k' | 'custom';

export const RESOLUTION_PRESETS = {
  '720p': '1280x720',
  '1080p': '1920x1080',
  '1440p': '2560x1440',
  '4k': '3840x2160',
} as const;

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  crf: 18,
  preset: 'medium',
  videoBitrate: 8_000_000,
  filename: 'stacked',
  outputResolution: RESOLUTION_PRESETS['720p'],
  resolutionPreset: '720p',
};

/** Preset definitions for common export scenarios. */
export interface ExportPreset {
  /** Unique identifier for the preset (e.g., 'fast', 'balanced'). Used for programmatic lookup. */
  name: string;
  /** User-friendly label displayed in the UI (e.g., "Fast (CRF 23, ultrafast)"). */
  label: string;
  /** H.264 Constant Rate Factor value (0-51; lower = higher quality). */
  crf: number;
  /** libx264 preset for encoding speed/quality tradeoff. */
  preset: ExportSettings['preset'];
  /** Target video bitrate in bits/s for WebCodecs path. */
  videoBitrate: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    name: 'fast',
    label: 'Fast (CRF 23, ultrafast)',
    crf: 23,
    preset: 'ultrafast',
    videoBitrate: 5_000_000,
  },
  {
    name: 'balanced',
    label: 'Balanced (CRF 18, medium)',
    crf: 18,
    preset: 'medium',
    videoBitrate: 8_000_000,
  },
  {
    name: 'high',
    label: 'High Quality (CRF 15, slow)',
    crf: 15,
    preset: 'slow',
    videoBitrate: 12_000_000,
  },
  {
    name: 'archive',
    label: 'Archive (CRF 8, veryslow)',
    crf: 8,
    preset: 'veryslow',
    videoBitrate: 20_000_000,
  },
];

/**
 * A text overlay (caption, ticker, title) rendered via FFmpeg's drawtext filter.
 * All overlays are independent of clips and applied to the final composed video.
 */
export interface TextOverlay {
  /** Unique identifier */
  id: string;
  /** Text content to display */
  text: string;
  /** Font size in pixels */
  fontsize: number;
  /** Font color — any FFmpeg color value: name ('white'), hex ('#ffffff'), or '0xRRGGBB' */
  fontcolor: string;
  /** X position in pixels from left (ignored for scrolling text, which starts off-screen right) */
  x: number;
  /** Y position in pixels from top */
  y: number;
  /** When true the text scrolls right-to-left (news-ticker style) */
  scrolling: boolean;
  /** Horizontal scroll speed in pixels per second (only used when scrolling is true) */
  scrollSpeed: number;
  /** Whether to draw a filled background box behind the text */
  box: boolean;
  /** Box color — supports alpha, e.g. 'black@0.5' or '0x000000@0.5' */
  boxColor: string;
}

export interface SerializedClipGroup {
  id: string;
  activeVariant: 'A' | 'B';
}

export interface Project {
  clips: SerializedClip[];
  clipGroups?: SerializedClipGroup[];
  transitions?: SerializedTransition[];
  textOverlays?: TextOverlay[];
}

/**
 * Describes which rendering path will be used and why.
 * Exposed before/during render to help users understand performance implications.
 */
export interface RenderPlan {
  /** Which rendering strategy will be used */
  path: 'lossless-concat' | 'effects-reencoding' | 'transitions' | 'pip' | 'textoverlays';
  /** Brief human-readable reason (e.g., "Clip has 0.5s fade", "Transitions enabled") */
  reason: string;
  /** Whether re-encoding will occur (lossless = false, others = true) */
  willReencode: boolean;
  /** User-friendly description for UI display */
  description: string;
}
