import type { Clip } from '../../types';
import { MIN_CLIP_DURATION } from '../media';
import { clampClipVolume } from '../audioVolume';
import {
  clampPixelRectToCanvas,
  isPixelRectOffCanvas,
  resolveClipLayoutPixels,
  type CanvasSize,
} from '../overlayCoords';
import {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  FADE_SAFETY_MARGIN,
} from './constants';

export function getClipDuration(clip: Clip): number {
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  return Math.max(MIN_CLIP_DURATION, end - clip.trimStart);
}

/**
 * Clamp a PiP overlay's x/y position so that at least one pixel of the
 * overlay remains within the canvas bounds, preventing it from being
 * positioned fully off-screen.
 */
export function clampOverlayPosition(
  clip: Pick<Clip, 'x' | 'y' | 'width' | 'height' | 'videoWidth' | 'videoHeight'>,
  canvasWidth: number = DEFAULT_CANVAS_WIDTH,
  canvasHeight: number = DEFAULT_CANVAS_HEIGHT,
): { x: number; y: number } {
  const canvas: CanvasSize = { width: canvasWidth, height: canvasHeight };
  const rect = resolveClipLayoutPixels(clip, canvas);
  const clamped = clampPixelRectToCanvas(rect, canvas);
  return { x: clamped.x, y: clamped.y };
}

/**
 * Returns true if a PiP overlay's configured position would place it
 * entirely outside the canvas (i.e. fully invisible in the render).
 */
export function isOverlayOffCanvas(
  clip: Pick<Clip, 'x' | 'y' | 'width' | 'height' | 'videoWidth' | 'videoHeight'>,
  canvasWidth: number = DEFAULT_CANVAS_WIDTH,
  canvasHeight: number = DEFAULT_CANVAS_HEIGHT,
): boolean {
  const canvas: CanvasSize = { width: canvasWidth, height: canvasHeight };
  const rect = resolveClipLayoutPixels(clip, canvas);
  return isPixelRectOffCanvas(rect, canvas);
}

export function sanitizeClipAdjustments(clip: Clip): void {
  clip.trimStart = Number.isFinite(clip.trimStart) ? Math.max(0, clip.trimStart) : 0;
  clip.trimEnd = Number.isFinite(clip.trimEnd)
    ? Math.max(clip.trimStart + MIN_CLIP_DURATION, clip.trimEnd)
    : NaN;

  const maxFade = Math.max(0, getClipDuration(clip) / 2 - FADE_SAFETY_MARGIN);
  clip.videoFadeIn = Math.min(Math.max(0, clip.videoFadeIn), maxFade);
  clip.videoFadeOut = Math.min(Math.max(0, clip.videoFadeOut), maxFade);
  clip.audioFadeIn = Math.min(Math.max(0, clip.audioFadeIn), maxFade);
  clip.audioFadeOut = Math.min(Math.max(0, clip.audioFadeOut), maxFade);
  if (clip.volume != null) {
    clip.volume = clampClipVolume(clip.volume);
  }
}
