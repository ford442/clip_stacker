/**
 * Content keys for composed frames and frame runs — the address of the
 * render cache (`export/renderCache/`) and the preview frame ring.
 *
 * The composition plan is already a pure description of a frame, so a frame
 * key is a hash of that plan plus the few inputs the compositor reads from
 * elsewhere: the bytes each layer decodes (`fingerprintMedia`), the clip
 * fields that pick a decoded frame (trim window, reverse, colour-space
 * override), and the frame-wide settings (finishing, colour management,
 * output size, the renderer build). Two frames with the same key are
 * identical by construction.
 *
 * What is deliberately *not* in a key, so an edit elsewhere on the timeline
 * does not invalidate a frame that looks the same:
 * - clip ids and timeline indices (a split or a ripple renames / renumbers
 *   placements without changing a pixel);
 * - the frame's absolute output time — except where the picture depends on
 *   it: a title or caption layer animates on its clock, and film grain is
 *   seeded by the frame index.
 *
 * Temporal noise reduction is the one stateful pass: its frames depend on the
 * frames before them. Keys stay per frame; a *segment* key covers the whole
 * run in order, and the segmented export resets the temporal state at every
 * segment start, so a cached segment is still exactly what a fresh render of
 * it produces.
 *
 * Pure: no stores, no I/O.
 */

import type { Clip } from '../types';
import type {
  PreviewClipLayer,
  PreviewCompositionLayer,
  PreviewCompositionPlan,
} from '../composition/previewCompositionTypes';
import {
  isGrainActive,
  isNoiseReductionActive,
  type FinishingSettings,
} from '../finishing/finishing';
import type { ColorManagementSettings } from '../finishing/colorManagement';
import { clipIsReversed } from '../timeline/reverseClip';
import { xxhash64String } from '../utils/xxhash64';

/** Bump when the key derivation changes, so old cache entries stop matching. */
export const RENDER_KEY_VERSION = 1;

/** Frames per segment at most: the export GOP (a key frame every 60 frames). */
export const RENDER_SEGMENT_MAX_FRAMES = 60;

/**
 * JSON with object keys sorted at every level and `undefined` fields left
 * out, so two plans built along different code paths hash alike.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (ArrayBuffer.isView(value)) {
    return canonicalJson(Array.from(value as unknown as ArrayLike<number>));
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined && typeof record[key] !== 'function')
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export interface RenderSettingsInput {
  finishing?: FinishingSettings | undefined;
  colorManagement?: ColorManagementSettings | undefined;
  /** Output (export) or canvas (preview) size in pixels. */
  width: number;
  height: number;
  /** Identifies the renderer code (shaders, plan maths): `__CLIP_STACKER_BUILD_ID__`. */
  buildId: string;
}

/** Hash of everything that applies to every frame of a render alike. */
export function renderSettingsHash(input: RenderSettingsInput): string {
  return xxhash64String(
    canonicalJson({
      v: RENDER_KEY_VERSION,
      build: input.buildId,
      size: [input.width, input.height],
      finishing: input.finishing ?? null,
      color: input.colorManagement ?? null,
    }),
  );
}

/** Whether a frame's pixels depend on the frames before it (temporal noise reduction). */
export function finishingIsTemporal(finishing: FinishingSettings | undefined): boolean {
  const pass = finishing?.noiseReduction;
  return Boolean(pass?.temporal) && (pass?.temporalStrength ?? 0) > 0 && isNoiseReductionActive(pass);
}

/** Whether a frame's pixels depend on its index (grain seed). */
export function finishingIsFrameSeeded(finishing: FinishingSettings | undefined): boolean {
  return isGrainActive(finishing?.grain);
}

export interface FrameKeyContext {
  /** Every clip a layer id can name (`withNestedInstances(clips)`), by id. */
  clipsById: ReadonlyMap<string, Clip>;
  /**
   * Content key of the bytes the compositor decodes for `clip` (the original
   * for export; the proxy when the preview reads one), or null when unknown.
   */
  mediaKey: (clip: Clip) => string | null;
  /** `renderSettingsHash` of this render. */
  settingsHash: string;
  /** The grain seed this frame is drawn with, or null when grain is off. */
  grainSeed: number | null;
}

export interface FrameKey {
  /** Content hash, or null when the frame cannot be cached (see `uncacheable`). */
  key: string | null;
  /**
   * What is on screen, by placement: which clips / titles / captions are
   * drawn, ignoring per-frame values. A change starts a new segment, so
   * segments line up with cuts and title in / out points.
   */
  structure: string;
  /** Why `key` is null. */
  uncacheable?: string;
}

/** The fields of a clip that decide which decoded frame a layer shows. */
function clipMediaSignature(clip: Clip, mediaKey: string): Record<string, unknown> {
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  return {
    media: mediaKey,
    kind: clip.kind,
    still: Boolean(clip.stillImage),
    reverse: clipIsReversed(clip),
    trim: [clip.trimStart, trimEnd],
    colorSpace: clip.colorSpaceOverride ?? null,
  };
}

function clipLayerContent(
  layer: PreviewClipLayer,
  ctx: FrameKeyContext,
): { content: Record<string, unknown> } | { uncacheable: string } {
  if (layer.mediaObjectUrl) return { uncacheable: 'a RIFE morph segment (its own blob)' };
  const clip = ctx.clipsById.get(layer.clipId);
  if (!clip) return { uncacheable: `layer clip ${layer.clipId} is not on the timeline` };
  if (clip.offline) return { uncacheable: 'an offline clip (slate)' };
  const mediaKey = ctx.mediaKey(clip);
  if (!mediaKey) return { uncacheable: `no media fingerprint for "${clip.title}"` };
  const { clipId: _clipId, timelineIndex: _timelineIndex, crossfade, ...rest } = layer;
  let fade: Record<string, unknown> | null = null;
  if (crossfade) {
    // The other side of a transition is its own layer; ids and the absolute
    // start do not change what the shader draws.
    const {
      outgoingClipId: _outgoing,
      incomingClipId: _incoming,
      startTime: _startTime,
      ...shape
    } = crossfade;
    fade = shape;
  }
  return { content: { ...rest, crossfade: fade, source: clipMediaSignature(clip, mediaKey) } };
}

function layerContent(
  layer: PreviewCompositionLayer,
  plan: PreviewCompositionPlan,
  ctx: FrameKeyContext,
): { content: Record<string, unknown> } | { uncacheable: string } {
  switch (layer.kind) {
    case 'base':
    case 'pip':
      return clipLayerContent(layer, ctx);
    case 'text': {
      const { overlayId: _id, timelineIndex: _index, overlay, time, ...rest } = layer;
      const { id: _overlayId, ...overlayContent } = overlay;
      // Titles animate (scroll, shader fills) on their own clock.
      return { content: { ...rest, overlay: overlayContent, time: time ?? plan.globalTime } };
    }
    case 'caption': {
      const { captionId: _id, timelineIndex: _index, ...rest } = layer;
      return { content: rest };
    }
  }
}

/** A title or caption that draws nothing (fully transparent, or no text). */
function isInvisibleTextLayer(layer: PreviewCompositionLayer): boolean {
  if (layer.kind === 'text') return !(layer.opacity > 0) || !layer.overlay.text;
  if (layer.kind === 'caption') return !(layer.opacity > 0) || !layer.text;
  return false;
}

function layerIdentity(layer: PreviewCompositionLayer): string {
  switch (layer.kind) {
    case 'base':
    case 'pip':
      return `${layer.kind}:${layer.clipId}:${layer.crossfade?.role ?? ''}`;
    case 'text':
      return `text:${layer.overlayId}`;
    case 'caption':
      return `caption:${layer.captionId}`;
  }
}

const MICROS = 1_000_000;

/** Snap seconds to the microsecond grid the decoders' timestamps live on. */
function toMicros(seconds: number): number {
  return Math.round(seconds * MICROS) / MICROS;
}

function froundDeep<T>(value: T): T {
  if (typeof value === 'number') return Math.fround(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => froundDeep(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = froundDeep(item);
    return out as T;
  }
  return value;
}

function quantizeClipLayer(layer: PreviewClipLayer): PreviewClipLayer {
  const { clipId, kind, mediaObjectUrl, sourceTime, localElapsed, crossfade, ...numbers } = layer;
  return {
    ...froundDeep(numbers),
    kind,
    clipId,
    ...(mediaObjectUrl !== undefined ? { mediaObjectUrl } : {}),
    sourceTime: toMicros(sourceTime),
    localElapsed: toMicros(localElapsed),
    crossfade: crossfade
      ? {
          ...froundDeep(crossfade),
          type: crossfade.type,
          role: crossfade.role,
          outgoingClipId: crossfade.outgoingClipId,
          incomingClipId: crossfade.incomingClipId,
        }
      : null,
  };
}

/**
 * The plan a cached render draws and keys: clip layers' source / elapsed
 * times and the frame clock snapped to microseconds, every other per-layer
 * number rounded to float32 (what the compositor's uniforms carry anyway).
 *
 * The same frame reached along two edit histories (say, after a ripple)
 * lands on values a few ulps apart, which would hash apart and — at an
 * exact frame boundary — even pick different decoded frames. Rendering the
 * quantized plan makes the key exact: equal keys, equal inputs.
 */
export function quantizePlan(plan: PreviewCompositionPlan): PreviewCompositionPlan {
  return {
    ...plan,
    globalTime: toMicros(plan.globalTime),
    layers: plan.layers.map((layer): PreviewCompositionLayer => {
      switch (layer.kind) {
        case 'base':
        case 'pip':
          return quantizeClipLayer(layer);
        case 'text':
          return {
            ...layer,
            x: Math.fround(layer.x),
            y: Math.fround(layer.y),
            opacity: Math.fround(layer.opacity),
            ...(layer.time !== undefined ? { time: toMicros(layer.time) } : {}),
          };
        case 'caption':
          return { ...layer, x: Math.fround(layer.x), y: Math.fround(layer.y), opacity: Math.fround(layer.opacity) };
      }
    }),
  };
}

/**
 * The content key of one composed frame. Key the plan you render, and
 * render a {@link quantizePlan}-ed one for keys to survive edits elsewhere.
 */
export function frameKey(plan: PreviewCompositionPlan, ctx: FrameKeyContext): FrameKey {
  // A title keyframed to opacity 0 spans the programme but draws nothing
  // there, so editing it only touches the frames where it shows.
  const drawn = plan.layers.filter((layer) => !isInvisibleTextLayer(layer));
  const structure = drawn.map(layerIdentity).join('|');
  const layers: Record<string, unknown>[] = [];
  for (const layer of drawn) {
    const result = layerContent(layer, plan, ctx);
    if ('uncacheable' in result) return { key: null, structure, uncacheable: result.uncacheable };
    layers.push(result.content);
  }
  const content = canonicalJson({
    settings: ctx.settingsHash,
    canvas: [plan.canvasWidth, plan.canvasHeight, plan.scale, plan.capped],
    grain: ctx.grainSeed,
    layers,
  });
  return { key: xxhash64String(content), structure };
}

/** A run of consecutive output frames rendered, cached and muxed as one unit. */
export interface FrameSegment {
  /** First output frame (inclusive). */
  start: number;
  /** One past the last output frame. */
  end: number;
  /** Content key of the run in order, or null when any frame is uncacheable. */
  key: string | null;
  /** Why `key` is null. */
  uncacheable?: string;
}

/**
 * Group per-frame keys into segments: a new segment starts where the
 * structure (what is on screen) or cacheability changes, and every
 * `maxFrames` within a run, counted from the run's start — so a clip moved
 * along the timeline keeps its segment boundaries (and keys) relative to its
 * own start.
 */
export function segmentFrames(
  frames: readonly FrameKey[],
  options: { startFrame?: number; maxFrames?: number } = {},
): FrameSegment[] {
  const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? RENDER_SEGMENT_MAX_FRAMES));
  const base = options.startFrame ?? 0;
  const segments: FrameSegment[] = [];
  let runStart = 0;
  let segStart = 0;
  const close = (end: number) => {
    if (end <= segStart) return;
    const slice = frames.slice(segStart, end);
    const blocked = slice.find((frame) => frame.key === null);
    const segment: FrameSegment = blocked
      ? { start: base + segStart, end: base + end, key: null, uncacheable: blocked.uncacheable ?? 'uncacheable frame' }
      : {
          start: base + segStart,
          end: base + end,
          key: xxhash64String(`seg${RENDER_KEY_VERSION}:${slice.length}:${slice.map((f) => f.key).join(',')}`),
        };
    segments.push(segment);
    segStart = end;
  };
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const prev = i > 0 ? frames[i - 1]! : null;
    if (prev && (prev.structure !== frame.structure || (prev.key === null) !== (frame.key === null))) {
      close(i);
      runStart = i;
    } else if (i - runStart > 0 && (i - runStart) % maxFrames === 0) {
      close(i);
    }
  }
  close(frames.length);
  return segments;
}
