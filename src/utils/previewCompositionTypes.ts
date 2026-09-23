/**
 * Shared types for the preview/export composition planner. Split out of
 * `previewComposition.ts` (which keeps `buildPreviewCompositionPlan` as the
 * single entry point) purely to keep each module under the repo's ~700-line
 * split convention — no behavior lives here beyond `captionPlanOptions`,
 * a small pure narrowing helper.
 */

import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  TextOverlayStyle,
} from '../types';
import type { StabMatrix } from '../wasm/videoStabilize';
import type { LayerKeyUniforms } from './overlayKey';

export type PreviewLayerKind = 'base' | 'pip' | 'text' | 'caption';

export interface PreviewPipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Active transition overlap between two adjacent timeline clips. */
export interface PreviewTransitionCrossfade {
  type: string;
  /** Output-timeline start of the overlap window (seconds). */
  startTime: number;
  duration: number;
  /** 0 at overlap start → 1 at overlap end. */
  progress: number;
  outgoingClipId: string;
  incomingClipId: string;
  /** Whether this layer is the outgoing or incoming side of the crossfade. */
  role: 'outgoing' | 'incoming';
  /** Per-transition shader uniforms from the clip transition config. */
  params?: Record<string, number>;
}

export interface PreviewClipLayer {
  kind: 'base' | 'pip';
  clipId: string;
  timelineIndex: number;
  zIndex: number;
  /** Seconds elapsed within the clip's trimmed output window. */
  localElapsed: number;
  clipDuration: number;
  /** Seek time in the clip's source media (seconds). */
  sourceTime: number;
  /** Combined opacity after fades, PiP opacity, and any transition crossfade. */
  opacity: number;
  rect: PreviewPipRect;
  crossfade: PreviewTransitionCrossfade | null;
  /** RIFE morph segment blob URL (bypasses clip lookup). */
  mediaObjectUrl?: string;
  /** Ken Burns / per-frame UV override (multiplied with letterbox UV). */
  uvScale?: [number, number];
  uvOffset?: [number, number];
  /**
   * Camera-shake correction sampled at this layer's `sourceTime`
   * (`[a, b, tx, c, d, ty]`). Omitted when the clip is not stabilized.
   */
  stabMatrix?: StabMatrix;
  /**
   * Chroma / luma key from the clip's `overlayBlend` + `chromaKey`. Omitted
   * when the clip is not keyed, so unkeyed layers stay structurally identical
   * to what they were before keying moved onto the compositors.
   */
  key?: LayerKeyUniforms;
}

export interface PreviewTextLayer {
  kind: 'text';
  overlayId: string;
  overlay: TextOverlay;
  timelineIndex: number;
  zIndex: number;
  x: number;
  y: number;
  opacity: number;
}

/**
 * One caption cue active at `globalTime`.
 *
 * Note the anchor: unlike {@link PreviewTextLayer} (top-left), `x`/`y` are the
 * cue's **bottom centre** in canvas pixels, matching the ASS burn-in path,
 * where every cue is alignment 2 with an explicit `\pos()`.
 */
export interface PreviewCaptionLayer {
  kind: 'caption';
  captionId: string;
  text: string;
  /** Per-cue style merged over the project style over the built-in defaults. */
  style: TextOverlayStyle;
  timelineIndex: number;
  zIndex: number;
  /** Horizontal centre in canvas px. */
  x: number;
  /** Bottom edge of the last line in canvas px. */
  y: number;
  opacity: number;
}

export type PreviewCompositionLayer =
  | PreviewClipLayer
  | PreviewTextLayer
  | PreviewCaptionLayer;

/**
 * Supplies decoded video frames for timeline layers without an `<video>`
 * element seek. Export uses this (see `TimelineDecoderFrameProvider` in
 * `decoderFrameProvider.ts`) because it always walks each layer's source time
 * monotonically forward, so a sequential `VideoDecoder` cursor can deliver
 * frames far faster than seeking. Live preview leaves this unset and keeps
 * the existing `ClipMediaPool` seek path, since scrubbing is genuinely random
 * access.
 */
export interface LayerFrameProvider {
  /**
   * Return a frame for this layer's clip at `layer.sourceTime`, or null to
   * fall back to the `<video>` / `ClipMediaPool` seek path for this layer
   * only (e.g. a codec/container the provider can't decode).
   */
  getFrame(layer: PreviewClipLayer, clip: Clip): Promise<VideoFrame | null>;
}

/** Optional controls passed into timeline preview renders. */
export interface TimelineRenderOptions {
  /** Return true when this render is stale and must not touch the canvas. */
  isCancelled?: () => boolean;
  /** Optional override for the preview height cap. */
  maxHeight?: number;
  /** Optional override for the preview width cap. */
  maxWidth?: number;
  /** Project finishing pass chain (WebGPU path only). */
  finishing?: import('./finishing').FinishingSettings;
  /** @deprecated Prefer `finishing`. */
  colorGrade?: import('./lut').ColorGradeSettings;
  /** Decoder-cursor frame source for export; omitted for live preview. */
  frameProvider?: LayerFrameProvider;
  /**
   * Integer frame index for temporal grain seed. Export should pass the
   * encoder loop index; preview may omit (derived from plan.globalTime).
   */
  frameIndex?: number;
  /**
   * Caption cues to draw. Omitted (or empty) leaves the plan caption-free,
   * which is what the soft-subtitle mux and the FFmpeg burn-in post-pass want.
   */
  captions?: CaptionEntry[];
  /** Project-wide caption style; per-cue `style` overrides win over it. */
  captionStyle?: Partial<TextOverlayStyle>;
}

/** Caption inputs for `buildPreviewCompositionPlan`. */
export interface CaptionPlanOptions {
  captions?: CaptionEntry[];
  captionStyle?: Partial<TextOverlayStyle>;
}

/** Narrow a plan's render options down to just its caption inputs. */
export function captionPlanOptions(
  options?: Pick<TimelineRenderOptions, 'captions' | 'captionStyle'>,
): CaptionPlanOptions {
  return {
    captions: options?.captions,
    captionStyle: options?.captionStyle,
  };
}

export interface PreviewCompositionPlan {
  globalTime: number;
  totalDuration: number;
  /** Capped preview canvas width (px) — what the compositor draws into. */
  canvasWidth: number;
  /** Capped preview canvas height (px). */
  canvasHeight: number;
  /**
   * Preview/output scale factor (≤ 1). Layer coordinates are already baked at
   * this scale; text fontsize is scaled by it at draw time.
   */
  scale: number;
  /** True when the preview resolution was reduced below the output resolution. */
  capped: boolean;
  /** Bottom → top draw order. */
  layers: PreviewCompositionLayer[];
  isEmpty: boolean;
}

/**
 * Common surface implemented by both timeline preview backends (WebGPU
 * `TimelinePreviewEngine` and Canvas2D `TimelineCanvas2DRenderer`) so the
 * preview UI can drive either one interchangeably.
 */
export interface TimelineCompositor {
  /** Build the plan for `globalTime` and composite it onto the canvas. */
  renderTimelineFrame(
    clips: Clip[],
    groups: ClipGroup[],
    transitions: ClipTransition[],
    overlays: TextOverlay[],
    settings: Pick<ExportSettings, 'outputResolution'> | undefined,
    globalTime: number,
    options?: TimelineRenderOptions,
  ): Promise<PreviewCompositionPlan>;
  syncClips(clips: Clip[]): void;
  /** Clear temporal finishing buffers after a discontinuous seek (WebGPU only). */
  resetFinishingTemporal?(): void;
  /** Pause pooled decoders for idle teardown (preview paused/backgrounded). */
  pauseDecoders(): void;
  destroy(): void;
}

/** Capped preview canvas geometry plus the output→preview scale factor. */
export interface CanvasGeometry {
  /** Full output resolution (where clip x/y/width/height are authored). */
  outputWidth: number;
  outputHeight: number;
  /** Capped preview canvas dimensions actually drawn. */
  canvasWidth: number;
  canvasHeight: number;
  /** canvasHeight / outputHeight (≤ 1). */
  scale: number;
  capped: boolean;
}

export interface ClipTimelineSegment {
  clip: Clip;
  /** Index in the full timeline clip list. */
  timelineIndex: number;
  /** Index within the scheduled clip list passed to buildClipTimelineSegments. */
  scheduleIndex: number;
  duration: number;
  startTime: number;
  endTime: number;
}
