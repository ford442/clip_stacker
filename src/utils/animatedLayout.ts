import type { Clip, TextOverlay } from '../types';
import { sampleKeyframes } from './keyframes';
import { clampOverlayPosition } from './project';
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

function baseClipWidth(clip: Clip, outputWidth: number): number {
  if (clip.width && clip.width > 0) return clip.width;
  if (clip.videoWidth && clip.videoWidth > 0) return clip.videoWidth;
  return outputWidth;
}

function baseClipHeight(clip: Clip, outputHeight: number): number {
  if (clip.height && clip.height > 0) return clip.height;
  if (clip.videoHeight && clip.videoHeight > 0) return clip.videoHeight;
  return outputHeight;
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
  const width = sampleKeyframes(kf?.width, localTime, baseClipWidth(clip, outputWidth));
  const height = sampleKeyframes(
    kf?.height,
    localTime,
    baseClipHeight(clip, outputHeight),
  );
  const sampledClip: Pick<Clip, 'x' | 'y' | 'width' | 'height'> = {
    x: sampleKeyframes(kf?.x, localTime, clip.x ?? 0),
    y: sampleKeyframes(kf?.y, localTime, clip.y ?? 0),
    width,
    height,
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
  scale: number,
  textWidth = 0,
): AnimatedTextLayout {
  const kf = overlay.keyframes;
  const opacity = sampleKeyframes(kf?.opacity, globalTime, 1);

  if (overlay.scrolling) {
    return {
      x: resolveScrollingX(overlay.scrollSpeed, globalTime, canvasWidth, textWidth),
      y: sampleKeyframes(kf?.y, globalTime, overlay.y) * scale,
      opacity,
    };
  }

  return {
    x: sampleKeyframes(kf?.x, globalTime, overlay.x) * scale,
    y: sampleKeyframes(kf?.y, globalTime, overlay.y) * scale,
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
