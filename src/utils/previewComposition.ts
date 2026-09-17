import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  TextOverlayStyle,
} from '../types';
import { computeFadeAlpha } from './fadePreview';
import { sampleKeyframes } from './keyframes';
import {
  clampOverlayPosition,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  getClipDuration,
} from './project';
import { sourceTimeAtOutputLocal, wrapOutputLocalToCycle } from './timeRemap';
import { parseOutputResolution } from './resolution';
import { computeTotalDuration } from './transitions';
import {
  isMorphSegmentReady,
  isMorphTransition,
  morphClipId,
} from './morphTransition';
import {
  clipHasKeyframes,
  resolveAnimatedClipLayout,
  resolveAnimatedTextLayout,
} from './animatedLayout';
import { getTimelineClips } from './timelineClips';
import { placementWindow } from './trackStacking';
import { capPreviewResolution, DEFAULT_PREVIEW_MAX_HEIGHT } from './previewBudget';
import { resolveTransitionShaderId } from '../webgpu/transitions/registry';
import { isStabilizationActive, stabMatrixForClip } from './stabilization';
import type { StabMatrix } from '../wasm/videoStabilize';
import { layerKeyEntry, type LayerKeyUniforms } from './overlayKey';
import { normalizeCaptions, resolveCaptionStyle } from './subtitles';

/**
 * Spread-in `stabMatrix` for a clip, or nothing at all when it is not
 * stabilized — an absent key keeps unstabilized layers structurally identical
 * to what they were before stabilization existed.
 */
function stabMatrixEntry(
  clip: Clip,
  sourceTime: number,
): { stabMatrix?: StabMatrix } {
  if (!isStabilizationActive(clip)) return {};
  return { stabMatrix: stabMatrixForClip(clip, sourceTime) };
}

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

/** Optional controls passed into timeline preview renders. */
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

/** Caption inputs for {@link buildPreviewCompositionPlan}. */
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
interface CanvasGeometry {
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

interface ClipTimelineSegment {
  clip: Clip;
  /** Index in the full timeline clip list. */
  timelineIndex: number;
  /** Index within the scheduled clip list passed to buildClipTimelineSegments. */
  scheduleIndex: number;
  duration: number;
  startTime: number;
  endTime: number;
}

function isActiveTransition(transition: ClipTransition | undefined): transition is ClipTransition {
  return Boolean(transition && transition.type !== 'none' && transition.duration > 0);
}

function buildTransitionMap(transitions: ClipTransition[]): Map<number, ClipTransition> {
  return new Map(
    transitions
      .filter((transition) => isActiveTransition(transition))
      .map((transition) => [transition.afterClipIndex, transition] as const),
  );
}

function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

/** Keep transitions between adjacent base-layer clips (matches FFmpeg PiP base chain). */
export function filterBaseLayerTransitions(
  timelineClips: Clip[],
  transitions: ClipTransition[],
): ClipTransition[] {
  const baseTimelineIndices = timelineClips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => isBaseClip(clip))
    .map(({ index }) => index);

  const remapped: ClipTransition[] = [];
  for (let baseSlot = 1; baseSlot < baseTimelineIndices.length; baseSlot++) {
    const previousTimelineIndex = baseTimelineIndices[baseSlot - 1];
    const timelineIndex = baseTimelineIndices[baseSlot];
    if (timelineIndex !== previousTimelineIndex + 1) continue;

    const transition = transitions.find(
      (item) => item.afterClipIndex === timelineIndex,
    );
    if (isActiveTransition(transition)) {
      remapped.push({ ...transition, afterClipIndex: baseSlot });
    }
  }
  return remapped;
}

/** Map each clip to its output start/end times (matches xfade offset math). */
export function buildClipTimelineSegments(
  clips: Clip[],
  transitions: ClipTransition[],
  timelineIndices: number[],
): ClipTimelineSegment[] {
  if (clips.length === 0) return [];

  const durations = clips.map(getClipDuration);
  const transMap = buildTransitionMap(transitions);
  const segments: ClipTimelineSegment[] = [];
  let accumulated = 0;
  let overlapSoFar = 0;

  for (let scheduleIndex = 0; scheduleIndex < clips.length; scheduleIndex++) {
    let startTime = 0;
    if (scheduleIndex > 0) {
      const transition = transMap.get(scheduleIndex);
      startTime = transition
        ? accumulated - overlapSoFar - transition.duration
        : accumulated - overlapSoFar;
    }

    segments.push({
      clip: clips[scheduleIndex],
      timelineIndex: timelineIndices[scheduleIndex],
      scheduleIndex,
      duration: durations[scheduleIndex],
      startTime,
      endTime: startTime + durations[scheduleIndex],
    });

    if (scheduleIndex > 0) {
      const appliedTransition = transMap.get(scheduleIndex);
      if (appliedTransition) {
        overlapSoFar += appliedTransition.duration;
      }
    }
    accumulated += durations[scheduleIndex];
  }

  return segments;
}

export interface CanvasSizeOptions {
  maxHeight?: number;
  maxWidth?: number;
}

function resolveCanvasSize(
  settings: Pick<ExportSettings, 'outputResolution'> | undefined,
  options: CanvasSizeOptions,
): CanvasGeometry {
  const { width, height } = parseOutputResolution(settings?.outputResolution);
  const outputWidth = width || DEFAULT_CANVAS_WIDTH;
  const outputHeight = height || DEFAULT_CANVAS_HEIGHT;

  let canvasWidth = outputWidth;
  let canvasHeight = outputHeight;
  let scale = 1;
  let capped = false;

  const maxHeight = options.maxHeight ?? DEFAULT_PREVIEW_MAX_HEIGHT;
  const heightCap = capPreviewResolution(canvasWidth, canvasHeight, maxHeight);
  canvasWidth = heightCap.width;
  canvasHeight = heightCap.height;
  scale = heightCap.scale;
  capped = heightCap.capped;

  if (options.maxWidth && canvasWidth > options.maxWidth) {
    const widthScale = options.maxWidth / canvasWidth;
    canvasWidth = options.maxWidth;
    canvasHeight = Math.max(1, Math.round(canvasHeight * widthScale));
    scale *= widthScale;
    capped = true;
  }

  return {
    outputWidth,
    outputHeight,
    canvasWidth,
    canvasHeight,
    scale,
    capped,
  };
}

/**
 * Resolve a clip's destination rect and optional UV animation at `localTime`.
 */
function resolveClipRectAtTime(
  clip: Clip,
  geom: CanvasGeometry,
  localTime: number,
): { rect: PreviewPipRect; uvScale: [number, number]; uvOffset: [number, number] } {
  const isBase = (clip.layerIndex ?? 0) === 0;
  const hasAnimation = clip.stillImage || clipHasKeyframes(clip) || !isBase;

  if (isBase && !hasAnimation) {
    return {
      rect: { x: 0, y: 0, width: geom.canvasWidth, height: geom.canvasHeight },
      uvScale: [1, 1],
      uvOffset: [0, 0],
    };
  }

  const layout = resolveAnimatedClipLayout(
    clip,
    localTime,
    geom.outputWidth,
    geom.outputHeight,
    geom.scale,
  );

  if (isBase && !clip.stillImage && !clipHasKeyframes(clip)) {
    return {
      rect: { x: 0, y: 0, width: geom.canvasWidth, height: geom.canvasHeight },
      uvScale: layout.uvScale,
      uvOffset: layout.uvOffset,
    };
  }

  return {
    rect: {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
    },
    uvScale: layout.uvScale,
    uvOffset: layout.uvOffset,
  };
}

/** @deprecated Use resolveClipRectAtTime — static layout without keyframes. */
function resolveClipRect(clip: Clip, geom: CanvasGeometry): PreviewPipRect {
  if (isBaseClip(clip)) {
    return { x: 0, y: 0, width: geom.canvasWidth, height: geom.canvasHeight };
  }

  const { x, y } = clampOverlayPosition(clip, geom.outputWidth, geom.outputHeight);
  const width =
    clip.width && clip.width > 0
      ? clip.width
      : clip.videoWidth && clip.videoWidth > 0
        ? clip.videoWidth
        : geom.outputWidth;
  const height =
    clip.height && clip.height > 0
      ? clip.height
      : clip.videoHeight && clip.videoHeight > 0
        ? clip.videoHeight
        : geom.outputHeight;

  return {
    x: x * geom.scale,
    y: y * geom.scale,
    width: width * geom.scale,
    height: height * geom.scale,
  };
}

function isClipActiveAtTime(segment: ClipTimelineSegment, globalTime: number): boolean {
  return globalTime >= segment.startTime && globalTime < segment.endTime;
}

function buildCrossfadeForSegment(
  segments: ClipTimelineSegment[],
  scheduleIndex: number,
  globalTime: number,
  transitions: ClipTransition[],
): PreviewTransitionCrossfade | null {
  if (scheduleIndex <= 0) return null;

  const segment = segments[scheduleIndex];
  const transition = transitions.find(
    (item) => item.afterClipIndex === scheduleIndex,
  );
  if (!isActiveTransition(transition)) return null;
  if (isMorphTransition(transition) && isMorphSegmentReady(transition)) {
    return null;
  }

  const overlapStart = segment.startTime;
  const overlapEnd = overlapStart + transition.duration;
  if (globalTime < overlapStart || globalTime >= overlapEnd) return null;

  const progress = Math.max(
    0,
    Math.min(1, (globalTime - overlapStart) / transition.duration),
  );

  const previewType =
    isMorphTransition(transition) && !isMorphSegmentReady(transition)
      ? 'dissolve'
      : resolveTransitionShaderId(transition);

  return {
    type: previewType,
    startTime: overlapStart,
    duration: transition.duration,
    progress,
    outgoingClipId: segments[scheduleIndex - 1].clip.id,
    incomingClipId: segment.clip.id,
    role: 'incoming',
    params: transition.params,
  };
}

function isInMorphOverlap(
  segments: ClipTimelineSegment[],
  scheduleIndex: number,
  globalTime: number,
  transition: ClipTransition,
): boolean {
  if (scheduleIndex <= 0) return false;
  const segment = segments[scheduleIndex];
  const overlapStart = segment.startTime;
  return (
    globalTime >= overlapStart &&
    globalTime < overlapStart + transition.duration
  );
}

function buildMorphLayer(
  transition: ClipTransition,
  segment: ClipTimelineSegment,
  globalTime: number,
  geom: CanvasGeometry,
): PreviewClipLayer {
  const overlapStart = segment.startTime;
  const localElapsed = globalTime - overlapStart;
  const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
    segment.clip,
    geom,
    localElapsed,
  );
  return {
    kind: 'base',
    clipId: morphClipId(transition.afterClipIndex),
    timelineIndex: segment.timelineIndex,
    zIndex: segment.scheduleIndex * 10 + 1,
    localElapsed,
    clipDuration: transition.duration,
    sourceTime: localElapsed,
    opacity: 1,
    rect,
    crossfade: null,
    mediaObjectUrl: transition.morphSegment!.objectUrl,
    uvScale,
    uvOffset,
  };
}

function clipLayerOpacity(
  clip: Clip,
  localElapsed: number,
  clipDuration: number,
  crossfade: PreviewTransitionCrossfade | null,
): number {
  const staticOpacity = !isBaseClip(clip) ? (clip.opacity ?? 1) : 1;
  const keyedOpacity = sampleKeyframes(
    clip.keyframes?.opacity,
    localElapsed,
    staticOpacity,
  );
  const fadeAlpha = computeFadeAlpha(
    localElapsed,
    clipDuration,
    clip.videoFadeIn,
    clip.videoFadeOut,
  );

  if (!crossfade) {
    return fadeAlpha * keyedOpacity;
  }

  const crossfadeAlpha =
    crossfade.role === 'incoming' ? crossfade.progress : 1 - crossfade.progress;
  return fadeAlpha * keyedOpacity * crossfadeAlpha;
}

function buildScheduledClipLayer(
  segment: ClipTimelineSegment,
  globalTime: number,
  segments: ClipTimelineSegment[],
  transitions: ClipTransition[],
  geom: CanvasGeometry,
): PreviewClipLayer | null {
  if (!isClipActiveAtTime(segment, globalTime)) return null;

  const localElapsed = globalTime - segment.startTime;
  const crossfade = buildCrossfadeForSegment(
    segments,
    segment.scheduleIndex,
    globalTime,
    transitions,
  );
  const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
    segment.clip,
    geom,
    localElapsed,
  );

  const sourceTime = sourceTimeAtOutputLocal(
    segment.clip,
    wrapOutputLocalToCycle(segment.clip, localElapsed).cycleLocalT,
  );

  return {
    kind: 'base',
    clipId: segment.clip.id,
    timelineIndex: segment.timelineIndex,
    zIndex:
      segment.scheduleIndex * 10 + (crossfade?.role === 'incoming' ? 1 : 0),
    localElapsed,
    clipDuration: segment.duration,
    sourceTime,
    opacity: clipLayerOpacity(segment.clip, localElapsed, segment.duration, crossfade),
    rect,
    crossfade,
    uvScale,
    uvOffset,
    ...stabMatrixEntry(segment.clip, sourceTime),
    ...layerKeyEntry(segment.clip),
  };
}

function buildOutgoingCrossfadeLayer(
  segment: ClipTimelineSegment,
  crossfade: PreviewTransitionCrossfade,
  globalTime: number,
  geom: CanvasGeometry,
): PreviewClipLayer {
  const outgoingElapsed = globalTime - segment.startTime;
  const outgoingCrossfade: PreviewTransitionCrossfade = {
    ...crossfade,
    role: 'outgoing',
  };
  const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
    segment.clip,
    geom,
    outgoingElapsed,
  );

  const outgoingSourceTime = sourceTimeAtOutputLocal(
    segment.clip,
    wrapOutputLocalToCycle(segment.clip, outgoingElapsed).cycleLocalT,
  );

  return {
    kind: 'base',
    clipId: segment.clip.id,
    timelineIndex: segment.timelineIndex,
    zIndex: segment.scheduleIndex * 10,
    localElapsed: outgoingElapsed,
    clipDuration: segment.duration,
    sourceTime: outgoingSourceTime,
    opacity: clipLayerOpacity(
      segment.clip,
      outgoingElapsed,
      segment.duration,
      outgoingCrossfade,
    ),
    rect,
    crossfade: outgoingCrossfade,
    uvScale,
    uvOffset,
    ...stabMatrixEntry(segment.clip, outgoingSourceTime),
    ...layerKeyEntry(segment.clip),
  };
}

function isInIncomingCrossfade(
  segments: ClipTimelineSegment[],
  scheduleIndex: number,
  globalTime: number,
  transitions: ClipTransition[],
): boolean {
  return buildCrossfadeForSegment(segments, scheduleIndex, globalTime, transitions) !== null;
}

function collectScheduledClipLayers(
  segments: ClipTimelineSegment[],
  transitions: ClipTransition[],
  globalTime: number,
  geom: CanvasGeometry,
): PreviewClipLayer[] {
  const clipLayers: PreviewClipLayer[] = [];

  for (const segment of segments) {
    if (!isClipActiveAtTime(segment, globalTime)) continue;

    const transition = transitions.find(
      (item) => item.afterClipIndex === segment.scheduleIndex,
    );

    if (
      segment.scheduleIndex > 0 &&
      transition &&
      isMorphTransition(transition) &&
      isMorphSegmentReady(transition) &&
      isInMorphOverlap(
        segments,
        segment.scheduleIndex,
        globalTime,
        transition,
      )
    ) {
      clipLayers.push(
        buildMorphLayer(transition, segment, globalTime, geom),
      );
      continue;
    }

    const nextTransition = transitions.find(
      (item) => item.afterClipIndex === segment.scheduleIndex + 1,
    );
    if (
      nextTransition &&
      isMorphTransition(nextTransition) &&
      isMorphSegmentReady(nextTransition) &&
      segment.scheduleIndex + 1 < segments.length &&
      isInMorphOverlap(
        segments,
        segment.scheduleIndex + 1,
        globalTime,
        nextTransition,
      )
    ) {
      continue;
    }

    const crossfade = buildCrossfadeForSegment(
      segments,
      segment.scheduleIndex,
      globalTime,
      transitions,
    );

    if (crossfade && segment.scheduleIndex > 0) {
      clipLayers.push(
        buildOutgoingCrossfadeLayer(
          segments[segment.scheduleIndex - 1],
          crossfade,
          globalTime,
          geom,
        ),
      );
      const incomingLayer = buildScheduledClipLayer(
        segment,
        globalTime,
        segments,
        transitions,
        geom,
      );
      if (incomingLayer) clipLayers.push(incomingLayer);
      continue;
    }

    const nextSegment = segments[segment.scheduleIndex + 1];
    if (
      nextSegment &&
      isInIncomingCrossfade(
        segments,
        nextSegment.scheduleIndex,
        globalTime,
        transitions,
      )
    ) {
      continue;
    }

    const layer = buildScheduledClipLayer(
      segment,
      globalTime,
      segments,
      transitions,
      geom,
    );
    if (layer) clipLayers.push(layer);
  }

  return clipLayers;
}

/**
 * Overlay (non-base) video layers.
 *
 * Stacking order and timing come from the track model: `layerIndex` is the
 * clip's video-track index (bottom-up) and `timelineStart` is its
 * `TrackItem.startTime`, both stamped by `toLegacyTimelineView` via
 * `trackStacking.ts`. An overlay is drawn only while the playhead is inside
 * `[timelineStart, timelineStart + duration)`; legacy projects with no
 * placement fall back to `timelineStart = 0`, which is where the pre-track PiP
 * pipeline put them.
 */
function buildPipLayers(
  pipClips: Array<{ clip: Clip; timelineIndex: number }>,
  globalTime: number,
  totalDuration: number,
  geom: CanvasGeometry,
): PreviewClipLayer[] {
  if (globalTime < 0 || globalTime >= totalDuration) return [];

  return [...pipClips]
    .sort(
      (a, b) =>
        (a.clip.layerIndex ?? 1) - (b.clip.layerIndex ?? 1) ||
        a.timelineIndex - b.timelineIndex,
    )
    .filter(({ clip }) => {
      const { start, end } = placementWindow(clip, getClipDuration(clip));
      return globalTime >= start && globalTime < end;
    })
    .map(({ clip, timelineIndex }) => {
      const duration = getClipDuration(clip);
      const { start } = placementWindow(clip, duration);
      const localElapsed = Math.min(
        Math.max(0, globalTime - start),
        Math.max(0, duration - 1e-6),
      );
      const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
        clip,
        geom,
        localElapsed,
      );

      const sourceTime = sourceTimeAtOutputLocal(
        clip,
        wrapOutputLocalToCycle(clip, localElapsed).cycleLocalT,
      );

      return {
        kind: 'pip' as const,
        clipId: clip.id,
        timelineIndex,
        zIndex: 1000 + (clip.layerIndex ?? 1) * 100 + timelineIndex,
        localElapsed,
        clipDuration: duration,
        sourceTime,
        opacity: clipLayerOpacity(clip, localElapsed, duration, null),
        rect,
        crossfade: null,
        uvScale,
        uvOffset,
        ...stabMatrixEntry(clip, sourceTime),
        ...layerKeyEntry(clip),
      };
    });
}

function buildTextLayers(
  overlays: TextOverlay[],
  globalTime: number,
  totalDuration: number,
  geom: CanvasGeometry,
): PreviewTextLayer[] {
  if (overlays.length === 0 || totalDuration <= 0) return [];
  if (globalTime < 0 || globalTime > totalDuration) return [];

  return overlays.map((overlay, index) => {
    const layout = resolveAnimatedTextLayout(
      overlay,
      globalTime,
      totalDuration,
      geom.canvasWidth,
      geom.canvasHeight,
      geom.scale,
    );
    return {
      kind: 'text' as const,
      overlayId: overlay.id,
      overlay,
      timelineIndex: index,
      zIndex: 2000 + index,
      x: layout.x,
      y: layout.y,
      opacity: layout.opacity,
    };
  });
}

/**
 * Caption cues active at `globalTime`, as bottom-centre anchored layers.
 *
 * Captions are *not* clamped to `totalDuration` the way text overlays are —
 * a cue is drawn whenever the playhead is inside it, which is exactly what
 * the CC lane shows and what the ASS burn-in does.
 */
function buildCaptionLayers(
  captions: CaptionEntry[],
  projectStyle: Partial<TextOverlayStyle> | undefined,
  globalTime: number,
  geom: CanvasGeometry,
): PreviewCaptionLayer[] {
  if (captions.length === 0) return [];
  if (globalTime < 0) return [];

  const layers: PreviewCaptionLayer[] = [];
  const normalized = normalizeCaptions(captions);
  for (let index = 0; index < normalized.length; index++) {
    const entry = normalized[index];
    if (globalTime < entry.startSec || globalTime >= entry.endSec) continue;
    if (!entry.text) continue;

    const style = resolveCaptionStyle(entry, projectStyle);
    layers.push({
      kind: 'caption',
      captionId: entry.id,
      text: entry.text,
      style,
      timelineIndex: index,
      // Above text overlays (2000+): burned-in captions are the last thing
      // drawn on the FFmpeg path too, since they run as a post-pass.
      zIndex: 3000 + index,
      x: style.x * geom.canvasWidth,
      y: style.y * geom.canvasHeight,
      opacity: 1,
    });
  }
  return layers;
}

/**
 * Pure composition planner: map global timeline time → ordered draw layers.
 */
export function buildPreviewCompositionPlan(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  overlays: TextOverlay[],
  settings: Pick<ExportSettings, 'outputResolution'> | undefined,
  globalTime: number,
  maxHeight: number = DEFAULT_PREVIEW_MAX_HEIGHT,
  maxWidth?: number,
  captionOptions?: CaptionPlanOptions,
): PreviewCompositionPlan {
  const timelineClips = getTimelineClips(clips, groups);
  const geom = resolveCanvasSize(settings, { maxHeight, maxWidth });
  const { canvasWidth, canvasHeight, scale, capped } = geom;
  const captions = captionOptions?.captions ?? [];
  const isEmpty =
    timelineClips.length === 0 && overlays.length === 0 && captions.length === 0;

  const pipClips = timelineClips
    .map((clip, timelineIndex) => ({ clip, timelineIndex }))
    .filter(({ clip }) => !isBaseClip(clip));
  const baseClips = timelineClips.filter(isBaseClip);
  const baseTimelineIndices = timelineClips
    .map((clip, timelineIndex) => ({ clip, timelineIndex }))
    .filter(({ clip }) => isBaseClip(clip))
    .map(({ timelineIndex }) => timelineIndex);

  const hasPip = pipClips.length > 0;
  const scheduleClips = hasPip ? baseClips : timelineClips;
  const scheduleTimelineIndices = hasPip
    ? baseTimelineIndices
    : timelineClips.map((_, index) => index);
  const scheduleTransitions = hasPip
    ? filterBaseLayerTransitions(timelineClips, transitions)
    : transitions;

  // Overlay lanes extend the output when they are placed past the base
  // sequence's end — an overlay at t=5s over a 3s base yields an 8s output
  // rather than being clipped away (Phase B: startTime is the output time).
  const baseDuration = computeTotalDuration(scheduleClips, scheduleTransitions);
  const totalDuration = pipClips.reduce((max, { clip }) => {
    const { end } = placementWindow(clip, getClipDuration(clip));
    return Math.max(max, end);
  }, baseDuration);
  const segments = buildClipTimelineSegments(
    scheduleClips,
    scheduleTransitions,
    scheduleTimelineIndices,
  );

  if (isEmpty || globalTime < 0 || (totalDuration > 0 && globalTime > totalDuration)) {
    return {
      globalTime,
      totalDuration,
      canvasWidth,
      canvasHeight,
      scale,
      capped,
      layers: [],
      isEmpty,
    };
  }

  const clipLayers = [
    ...collectScheduledClipLayers(
      segments,
      scheduleTransitions,
      globalTime,
      geom,
    ),
    ...buildPipLayers(pipClips, globalTime, totalDuration, geom),
  ];

  const textLayers = buildTextLayers(overlays, globalTime, totalDuration, geom);
  const captionLayers = buildCaptionLayers(
    captions,
    captionOptions?.captionStyle,
    globalTime,
    geom,
  );

  const layers = [...clipLayers, ...textLayers, ...captionLayers].sort(
    (a, b) => a.zIndex - b.zIndex,
  );

  return {
    globalTime,
    totalDuration,
    canvasWidth,
    canvasHeight,
    scale,
    capped,
    layers,
    isEmpty,
  };
}

/** Local clip time (seconds) at a global output-timeline position. */
export function resolveClipLocalTimeAtGlobal(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  clipId: string,
  globalTime: number,
): { localTime: number; duration: number } | null {
  const timelineClips = getTimelineClips(clips, groups);
  const clip = timelineClips.find((item) => item.id === clipId);
  if (!clip) return null;

  const duration = getClipDuration(clip);
  if ((clip.layerIndex ?? 0) > 0) {
    // Overlay lanes are placed at their track item's output time (Phase B).
    const { start } = placementWindow(clip, duration);
    const localTime = Math.min(
      Math.max(0, globalTime - start),
      Math.max(0, duration - 1e-6),
    );
    return { localTime, duration };
  }

  const baseClips = timelineClips.filter(isBaseClip);
  const baseTimelineIndices = timelineClips
    .map((item, timelineIndex) => ({ item, timelineIndex }))
    .filter(({ item }) => isBaseClip(item))
    .map(({ timelineIndex }) => timelineIndex);
  const pipClips = timelineClips.filter((item) => !isBaseClip(item));
  const hasPip = pipClips.length > 0;
  const scheduleClips = hasPip ? baseClips : timelineClips;
  const scheduleTimelineIndices = hasPip
    ? baseTimelineIndices
    : timelineClips.map((_, index) => index);
  const scheduleTransitions = hasPip
    ? filterBaseLayerTransitions(timelineClips, transitions)
    : transitions;

  const segments = buildClipTimelineSegments(
    scheduleClips,
    scheduleTransitions,
    scheduleTimelineIndices,
  );
  const segment = segments.find((item) => item.clip.id === clipId);
  if (!segment) return null;
  if (globalTime < segment.startTime || globalTime >= segment.endTime) {
    return { localTime: 0, duration };
  }
  return { localTime: globalTime - segment.startTime, duration };
}
