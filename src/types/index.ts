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
  /** PiP / compositing layout properties */
  layerIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
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

export interface Project {
  clips: SerializedClip[];
  transitions?: SerializedTransition[];
  textOverlays?: TextOverlay[];
}
