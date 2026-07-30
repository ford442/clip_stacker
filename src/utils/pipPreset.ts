import type { Clip } from '../types';
import { DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH } from './project';
import {
  clipLayoutPixelsToNormalized,
  type CanvasSize,
} from './overlayCoords';

export type { CanvasSize };

/** Corner the one-click Picture-in-Picture preset snaps the overlay to. */
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface PipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fraction of the canvas width the default overlay occupies (320px on a 1280px canvas). */
const PIP_WIDTH_RATIO = 0.25;
/** Inset from the canvas edges, as a fraction of the canvas width (32px on a 1280px canvas). */
const PIP_MARGIN_RATIO = 0.025;

/**
 * Parse an ExportSettings.outputResolution string ("1280x720") into a canvas size.
 * Falls back to the default canvas for 'original' or unparseable values.
 */
export function parseCanvasSize(outputResolution: string | undefined): CanvasSize {
  const match = /^(\d+)x(\d+)$/.exec((outputResolution ?? '').trim());
  if (!match) return { width: DEFAULT_CANVAS_WIDTH, height: DEFAULT_CANVAS_HEIGHT };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return { width: DEFAULT_CANVAS_WIDTH, height: DEFAULT_CANVAS_HEIGHT };
  return { width, height };
}

/**
 * Lowest overlay layer index that is free given the other clips on the timeline.
 * Overlay layers start at 1; the base layer (0) is never returned.
 */
export function nextOverlayLayerIndex(clips: Clip[], excludeClipId?: string): number {
  const used = new Set(
    clips
      .filter((c) => c.id !== excludeClipId)
      .map((c) => c.layerIndex ?? 0)
      .filter((index) => Number.isFinite(index) && index >= 1),
  );
  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

/**
 * Corner-overlay rectangle for the given canvas, preserving the clip's aspect ratio
 * when known (16:9 otherwise). On a 1280x720 canvas this yields 320x180.
 */
export function buildPipRect(
  canvas: CanvasSize,
  corner: PipCorner = 'bottom-right',
  aspectRatio?: number,
): PipRect {
  const ratio = Number.isFinite(aspectRatio) && (aspectRatio ?? 0) > 0 ? (aspectRatio as number) : 16 / 9;
  const width = Math.max(1, Math.round(canvas.width * PIP_WIDTH_RATIO));
  const height = Math.max(1, Math.round(width / ratio));
  const margin = Math.max(1, Math.round(canvas.width * PIP_MARGIN_RATIO));
  const left = margin;
  const top = margin;
  const right = Math.max(0, canvas.width - width - margin);
  const bottom = Math.max(0, canvas.height - height - margin);
  let pixels: PipRect;
  switch (corner) {
    case 'top-left':
      pixels = { x: left, y: top, width, height };
      break;
    case 'top-right':
      pixels = { x: right, y: top, width, height };
      break;
    case 'bottom-left':
      pixels = { x: left, y: bottom, width, height };
      break;
    case 'bottom-right':
    default:
      pixels = { x: right, y: bottom, width, height };
      break;
  }
  return clipLayoutPixelsToNormalized(pixels, canvas) as PipRect;
}

/** Aspect ratio of a clip's source video, or undefined when the dimensions are unknown. */
export function clipAspectRatio(clip: Pick<Clip, 'videoWidth' | 'videoHeight'>): number | undefined {
  const w = clip.videoWidth ?? 0;
  const h = clip.videoHeight ?? 0;
  if (w > 0 && h > 0) return w / h;
  return undefined;
}
