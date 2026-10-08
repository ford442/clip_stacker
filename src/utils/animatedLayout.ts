import type { Clip, ClipAnimatableProp, ClipKeyframes, TextOverlay } from '../types';
import { sampleKeyframes, upsertKeyframe } from './keyframes';
import { IDENTITY_PICTURE_TRANSFORM, type PictureTransform } from './clipTransform';
import { clampOverlayPosition } from './project';
import { resolveTextOverlayPixels } from './overlayCoords';
import { resolveScrollingX } from './textOverlay';

export interface AnimatedPipLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  uvScale: [number, number];
  uvOffset: [number, number];
}

export interface AnimatedTextLayout {
  x: number;
  y: number;
  opacity: number;
}

function baseClipOpacity(clip: Clip): number {
  return clip.opacity ?? 1;
}

function baseClipWidthNorm(clip: Clip, outputWidth: number): number {
  if (clip.width && clip.width > 0) return clip.width;
  if (clip.videoWidth && clip.videoWidth > 0) return clip.videoWidth / outputWidth;
  return 1;
}

function baseClipHeightNorm(clip: Clip, outputHeight: number): number {
  if (clip.height && clip.height > 0) return clip.height;
  if (clip.videoHeight && clip.videoHeight > 0) return clip.videoHeight / outputHeight;
  return 1;
}

/**
 * Resolve PiP / still-image layout at `localTime` (seconds within the clip window).
 */
export function resolveAnimatedClipLayout(
  clip: Clip,
  localTime: number,
  outputWidth: number,
  outputHeight: number,
  scale: number,
): AnimatedPipLayout {
  const kf = clip.keyframes;
  const widthNorm = sampleKeyframes(
    kf?.width,
    localTime,
    baseClipWidthNorm(clip, outputWidth),
  );
  const heightNorm = sampleKeyframes(
    kf?.height,
    localTime,
    baseClipHeightNorm(clip, outputHeight),
  );
  const width = widthNorm * outputWidth;
  const height = heightNorm * outputHeight;
  const sampledClip: Pick<Clip, 'x' | 'y' | 'width' | 'height' | 'videoWidth' | 'videoHeight'> = {
    x: sampleKeyframes(kf?.x, localTime, clip.x ?? 0),
    y: sampleKeyframes(kf?.y, localTime, clip.y ?? 0),
    width: widthNorm,
    height: heightNorm,
    videoWidth: clip.videoWidth,
    videoHeight: clip.videoHeight,
  };
  const { x, y } = clampOverlayPosition(sampledClip, outputWidth, outputHeight);
  const opacity = sampleKeyframes(kf?.opacity, localTime, baseClipOpacity(clip));

  const uvScaleX = sampleKeyframes(kf?.uvScaleX, localTime, 1);
  const uvScaleY = sampleKeyframes(kf?.uvScaleY, localTime, 1);
  const uvOffsetX = sampleKeyframes(kf?.uvOffsetX, localTime, 0);
  const uvOffsetY = sampleKeyframes(kf?.uvOffsetY, localTime, 0);

  return {
    x: x * scale,
    y: y * scale,
    width: width * scale,
    height: height * scale,
    opacity,
    uvScale: [uvScaleX, uvScaleY],
    uvOffset: [uvOffsetX, uvOffsetY],
  };
}

/** Default Ken Burns keyframes for still-image clips (subtle zoom + pan). */
export function createKenBurnsKeyframes(
  duration: number,
): NonNullable<Clip['keyframes']> {
  const end = Math.max(duration, 0.1);
  return {
    uvScaleX: [
      { t: 0, value: 1, easing: { type: 'linear' } },
      { t: end, value: 0.86 },
    ],
    uvScaleY: [
      { t: 0, value: 1, easing: { type: 'linear' } },
      { t: end, value: 0.86 },
    ],
    uvOffsetX: [
      { t: 0, value: 0, easing: { type: 'linear' } },
      { t: end, value: 0.05 },
    ],
    uvOffsetY: [
      { t: 0, value: 0, easing: { type: 'linear' } },
      { t: end, value: 0.03 },
    ],
  };
}

/**
 * Picture-transform keyframe lanes and the value an omitted lane means.
 * Rotation is stored in degrees (what the Inspector shows) and converted to
 * radians when sampled.
 */
export const PICTURE_TRANSFORM_DEFAULTS = {
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  anchorX: 0.5,
  anchorY: 0.5,
} as const satisfies Partial<Record<ClipAnimatableProp, number>>;

export type PictureTransformProp = keyof typeof PICTURE_TRANSFORM_DEFAULTS;

export const PICTURE_TRANSFORM_PROPS = Object.keys(
  PICTURE_TRANSFORM_DEFAULTS,
) as PictureTransformProp[];

export function isPictureTransformProp(
  prop: ClipAnimatableProp,
): prop is PictureTransformProp {
  return prop in PICTURE_TRANSFORM_DEFAULTS;
}

/** Sample a clip's authored picture transform at `localTime` (clip seconds). */
export function resolveAnimatedPictureTransform(
  clip: Pick<Clip, 'keyframes'>,
  localTime: number,
): PictureTransform {
  const kf = clip.keyframes;
  if (!kf || !PICTURE_TRANSFORM_PROPS.some((prop) => kf[prop]?.length)) {
    return IDENTITY_PICTURE_TRANSFORM;
  }
  const d = PICTURE_TRANSFORM_DEFAULTS;
  const rotationDeg = sampleKeyframes(kf.rotation, localTime, d.rotation);
  return {
    x: 0,
    y: 0,
    scaleX: sampleKeyframes(kf.scaleX, localTime, d.scaleX),
    scaleY: sampleKeyframes(kf.scaleY, localTime, d.scaleY),
    rotation: (rotationDeg * Math.PI) / 180,
    anchorX: sampleKeyframes(kf.anchorX, localTime, d.anchorX),
    anchorY: sampleKeyframes(kf.anchorY, localTime, d.anchorY),
  };
}

/**
 * True when rotation or scale keyframes move the picture at any point. Anchor
 * alone is a pivot, not a move, so it does not count.
 */
export function clipHasPictureTransform(clip: Pick<Clip, 'keyframes'>): boolean {
  const kf = clip.keyframes;
  if (!kf) return false;
  return (['rotation', 'scaleX', 'scaleY'] as const).some((prop) =>
    kf[prop]?.some((key) => key.value !== PICTURE_TRANSFORM_DEFAULTS[prop]),
  );
}

/** True when any picture-transform lane has more than one keyframe. */
export function clipHasAnimatedPictureTransform(clip: Pick<Clip, 'keyframes'>): boolean {
  const kf = clip.keyframes;
  if (!kf) return false;
  return PICTURE_TRANSFORM_PROPS.some((prop) => (kf[prop]?.length ?? 0) > 1);
}

/**
 * Keyframes other than the picture transform. A base clip with only
 * rotation / scale lanes keeps its full-frame rect, so adding a rotation does
 * not also resize it to the source's native size.
 */
export function clipHasLayoutKeyframes(clip: Pick<Clip, 'keyframes'>): boolean {
  if (!clip.keyframes) return false;
  return Object.entries(clip.keyframes).some(
    ([prop, track]) =>
      !isPictureTransformProp(prop as ClipAnimatableProp) && track && track.length > 0,
  );
}

/**
 * Set a picture-transform value the way the Inspector's fields and the
 * preview's rotate handle do: an empty or single-key lane is a static value
 * (and is dropped entirely when set back to the default, so the project
 * round-trips unchanged); an animated lane gets a keyframe at `localTime`.
 */
export function setPictureTransformValue(
  keyframes: ClipKeyframes | undefined,
  prop: PictureTransformProp,
  value: number,
  localTime: number,
): ClipKeyframes | undefined {
  const next: ClipKeyframes = { ...(keyframes ?? {}) };
  const track = next[prop];
  if (track && track.length > 1) {
    next[prop] = upsertKeyframe(track, localTime, value);
  } else if (value === PICTURE_TRANSFORM_DEFAULTS[prop]) {
    delete next[prop];
  } else {
    next[prop] = [{ t: 0, value }];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function clipHasKeyframes(clip: Clip): boolean {
  if (!clip.keyframes) return false;
  return Object.values(clip.keyframes).some((track) => track && track.length > 0);
}

export function textOverlayHasKeyframes(overlay: TextOverlay): boolean {
  if (!overlay.keyframes) return false;
  return Object.values(overlay.keyframes).some((track) => track && track.length > 0);
}

/**
 * Resolve text overlay position/opacity at `globalTime` on the output timeline.
 */
export function resolveAnimatedTextLayout(
  overlay: TextOverlay,
  globalTime: number,
  totalDuration: number,
  canvasWidth: number,
  canvasHeight: number,
  scale: number,
  textWidth = 0,
): AnimatedTextLayout {
  const kf = overlay.keyframes;
  const opacity = sampleKeyframes(kf?.opacity, globalTime, 1);

  if (overlay.scrolling) {
    const { y } = resolveTextOverlayPixels(
      { x: 0, y: sampleKeyframes(kf?.y, globalTime, overlay.y) },
      { width: canvasWidth / scale, height: canvasHeight / scale },
    );
    return {
      x: resolveScrollingX(overlay.scrollSpeed, globalTime, canvasWidth, textWidth),
      y: y * scale,
      opacity,
    };
  }

  const outputCanvas = { width: canvasWidth / scale, height: canvasHeight / scale };
  const sampled = resolveTextOverlayPixels(
    {
      x: sampleKeyframes(kf?.x, globalTime, overlay.x),
      y: sampleKeyframes(kf?.y, globalTime, overlay.y),
    },
    outputCanvas,
  );

  return {
    x: sampled.x * scale,
    y: sampled.y * scale,
    opacity,
  };
}

export function projectHasKeyframeAnimation(
  clips: Clip[],
  overlays: TextOverlay[],
): boolean {
  return (
    clips.some(clipHasKeyframes) ||
    overlays.some(textOverlayHasKeyframes)
  );
}
