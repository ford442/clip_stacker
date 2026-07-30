import type { Clip, TextOverlay } from '../types';
import type { Keyframe } from './keyframes';
import { DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH } from './project';

/** Canvas size in output pixels. */
export interface CanvasSize {
  width: number;
  height: number;
}

export const DEFAULT_TEXT_OVERLAY_X = 50 / DEFAULT_CANVAS_WIDTH;
export const DEFAULT_TEXT_OVERLAY_Y = 650 / DEFAULT_CANVAS_HEIGHT;

/** Nine anchor presets for quick text placement. */
export type TextAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const TEXT_ANCHOR_LABELS: Record<TextAnchor, string> = {
  'top-left': 'Top left',
  'top-center': 'Top center',
  'top-right': 'Top right',
  'center-left': 'Center left',
  center: 'Center',
  'center-right': 'Center right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
};

/** Default inset from canvas edges as a fraction of width (≈32px at 1280). */
const ANCHOR_MARGIN_X = 0.025;
const ANCHOR_MARGIN_Y = 0.044;

export function parseLayoutReferenceResolution(
  resolution: string | undefined,
): CanvasSize {
  const match = /^(\d+)x(\d+)$/.exec((resolution ?? '').trim());
  if (!match) {
    return { width: DEFAULT_CANVAS_WIDTH, height: DEFAULT_CANVAS_HEIGHT };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    return { width: DEFAULT_CANVAS_WIDTH, height: DEFAULT_CANVAS_HEIGHT };
  }
  return { width, height };
}

export function formatLayoutReferenceResolution(canvas: CanvasSize): string {
  return `${canvas.width}x${canvas.height}`;
}

export function normToPixelX(value: number, canvasWidth: number): number {
  return value * canvasWidth;
}

export function normToPixelY(value: number, canvasHeight: number): number {
  return value * canvasHeight;
}

export function pixelToNormX(pixels: number, canvasWidth: number): number {
  if (canvasWidth <= 0) return 0;
  return pixels / canvasWidth;
}

export function pixelToNormY(pixels: number, canvasHeight: number): number {
  if (canvasHeight <= 0) return 0;
  return pixels / canvasHeight;
}

export function resolveClipWidthPixels(
  clip: Pick<Clip, 'width' | 'videoWidth'>,
  canvasWidth: number,
): number {
  if (clip.width && clip.width > 0) return clip.width * canvasWidth;
  if (clip.videoWidth && clip.videoWidth > 0) return clip.videoWidth;
  return canvasWidth;
}

export function resolveClipHeightPixels(
  clip: Pick<Clip, 'height' | 'videoHeight'>,
  canvasHeight: number,
): number {
  if (clip.height && clip.height > 0) return clip.height * canvasHeight;
  if (clip.videoHeight && clip.videoHeight > 0) return clip.videoHeight;
  return canvasHeight;
}

export function resolveClipLayoutPixels(
  clip: Pick<Clip, 'x' | 'y' | 'width' | 'height' | 'videoWidth' | 'videoHeight'>,
  canvas: CanvasSize,
): { x: number; y: number; width: number; height: number } {
  return {
    x: normToPixelX(clip.x ?? 0, canvas.width),
    y: normToPixelY(clip.y ?? 0, canvas.height),
    width: resolveClipWidthPixels(clip, canvas.width),
    height: resolveClipHeightPixels(clip, canvas.height),
  };
}

export function resolveTextOverlayPixels(
  overlay: Pick<TextOverlay, 'x' | 'y'>,
  canvas: CanvasSize,
): { x: number; y: number } {
  return {
    x: normToPixelX(overlay.x, canvas.width),
    y: normToPixelY(overlay.y, canvas.height),
  };
}

export function clipLayoutPixelsToNormalized(
  pixels: { x: number; y: number; width: number; height: number },
  canvas: CanvasSize,
  preserveAutoSize = false,
): Pick<Clip, 'x' | 'y' | 'width' | 'height'> {
  return {
    x: pixelToNormX(pixels.x, canvas.width),
    y: pixelToNormY(pixels.y, canvas.height),
    width:
      preserveAutoSize && pixels.width <= 0
        ? 0
        : pixelToNormX(pixels.width, canvas.width),
    height:
      preserveAutoSize && pixels.height <= 0
        ? 0
        : pixelToNormY(pixels.height, canvas.height),
  };
}

export function textOverlayPixelsToNormalized(
  pixels: { x: number; y: number },
  canvas: CanvasSize,
): Pick<TextOverlay, 'x' | 'y'> {
  return {
    x: pixelToNormX(pixels.x, canvas.width),
    y: pixelToNormY(pixels.y, canvas.height),
  };
}

export function migratePixelClipLayout(
  clip: Pick<Clip, 'x' | 'y' | 'width' | 'height'>,
  reference: CanvasSize,
): Pick<Clip, 'x' | 'y' | 'width' | 'height'> {
  return {
    x: pixelToNormX(clip.x ?? 0, reference.width),
    y: pixelToNormY(clip.y ?? 0, reference.height),
    width:
      clip.width && clip.width > 0
        ? pixelToNormX(clip.width, reference.width)
        : 0,
    height:
      clip.height && clip.height > 0
        ? pixelToNormY(clip.height, reference.height)
        : 0,
  };
}

export function migratePixelTextOverlay(
  overlay: Pick<TextOverlay, 'x' | 'y'>,
  reference: CanvasSize,
): Pick<TextOverlay, 'x' | 'y'> {
  return {
    x: pixelToNormX(overlay.x, reference.width),
    y: pixelToNormY(overlay.y, reference.height),
  };
}

export function migrateKeyframeTrackToNormalized(
  track: Keyframe[] | undefined,
  referenceDimension: number,
): Keyframe[] | undefined {
  if (!track?.length || referenceDimension <= 0) return track;
  return track.map((key) => ({
    ...key,
    value: key.value / referenceDimension,
  }));
}

export function migrateClipKeyframesToNormalized(
  keyframes: Clip['keyframes'],
  reference: CanvasSize,
): Clip['keyframes'] {
  if (!keyframes) return keyframes;
  return {
    ...keyframes,
    ...(keyframes.x
      ? { x: migrateKeyframeTrackToNormalized(keyframes.x, reference.width) }
      : {}),
    ...(keyframes.y
      ? { y: migrateKeyframeTrackToNormalized(keyframes.y, reference.height) }
      : {}),
    ...(keyframes.width
      ? { width: migrateKeyframeTrackToNormalized(keyframes.width, reference.width) }
      : {}),
    ...(keyframes.height
      ? { height: migrateKeyframeTrackToNormalized(keyframes.height, reference.height) }
      : {}),
  };
}

export function migrateTextOverlayKeyframesToNormalized(
  keyframes: TextOverlay['keyframes'],
  reference: CanvasSize,
): TextOverlay['keyframes'] {
  if (!keyframes) return keyframes;
  return {
    ...keyframes,
    ...(keyframes.x
      ? { x: migrateKeyframeTrackToNormalized(keyframes.x, reference.width) }
      : {}),
    ...(keyframes.y
      ? { y: migrateKeyframeTrackToNormalized(keyframes.y, reference.height) }
      : {}),
  };
}

/**
 * Normalized anchor position for text overlays. Coordinates are the top-left
 * corner of the text box in output-normalized space.
 */
export function textAnchorToNormalized(
  anchor: TextAnchor,
  textWidthNorm: number,
  textHeightNorm: number,
): { x: number; y: number } {
  const marginX = ANCHOR_MARGIN_X;
  const marginY = ANCHOR_MARGIN_Y;
  const maxX = Math.max(0, 1 - textWidthNorm - marginX);
  const maxY = Math.max(0, 1 - textHeightNorm - marginY);

  let x = marginX;
  let y = marginY;

  if (anchor.includes('center') && !anchor.startsWith('center')) {
    x = (1 - textWidthNorm) / 2;
  } else if (anchor.endsWith('right')) {
    x = maxX;
  }

  if (anchor === 'center' || anchor === 'center-left' || anchor === 'center-right') {
    y = (1 - textHeightNorm) / 2;
  } else if (anchor.startsWith('bottom')) {
    y = maxY;
  }

  return { x, y };
}

/** Rough text size in normalized output space (for anchors before measurement). */
export function estimateTextSizeNormalized(
  overlay: Pick<TextOverlay, 'text' | 'fontsize'>,
  canvas: CanvasSize,
): { width: number; height: number } {
  const charWidth = overlay.fontsize * 0.55;
  const width = Math.min(1, (overlay.text.length * charWidth) / canvas.width);
  const height = overlay.fontsize / canvas.height;
  return { width, height };
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapGuide {
  axis: 'x' | 'y';
  position: number;
  kind: 'edge' | 'center' | 'third';
}

export const DEFAULT_SNAP_THRESHOLD_PX = 8;

const THIRD_LINES = [1 / 3, 2 / 3];

/**
 * Snap a rectangle in pixel space to canvas edges, center lines, and thirds.
 */
export function snapPixelRect(
  rect: PixelRect,
  canvas: CanvasSize,
  thresholdPx: number,
  disabled: boolean,
): { rect: PixelRect; guides: SnapGuide[] } {
  if (disabled || thresholdPx <= 0) {
    return { rect, guides: [] };
  }

  const guides: SnapGuide[] = [];
  let { x, y, width, height } = rect;
  const right = x + width;
  const bottom = y + height;
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  const xTargets: Array<{ value: number; kind: SnapGuide['kind']; pick: 'left' | 'center' | 'right' }> = [
    { value: 0, kind: 'edge', pick: 'left' },
    { value: canvas.width / 2, kind: 'center', pick: 'center' },
    { value: canvas.width, kind: 'edge', pick: 'right' },
    ...THIRD_LINES.map((fraction) => ({
      value: canvas.width * fraction,
      kind: 'third' as const,
      pick: 'center' as const,
    })),
  ];

  const yTargets: Array<{ value: number; kind: SnapGuide['kind']; pick: 'top' | 'center' | 'bottom' }> = [
    { value: 0, kind: 'edge', pick: 'top' },
    { value: canvas.height / 2, kind: 'center', pick: 'center' },
    { value: canvas.height, kind: 'edge', pick: 'bottom' },
    ...THIRD_LINES.map((fraction) => ({
      value: canvas.height * fraction,
      kind: 'third' as const,
      pick: 'center' as const,
    })),
  ];

  const pickBestSnap = (
    current: number,
    size: number,
    targets: Array<{ value: number; kind: SnapGuide['kind']; pick: string }>,
    axis: 'x' | 'y',
    edges: { start: number; center: number; end: number },
  ): number => {
    const candidates = [
      { delta: targets[0].value - edges.start, target: targets[0], edge: 'start' },
      { delta: targets[1].value - edges.center, target: targets[1], edge: 'center' },
      { delta: targets[2].value - edges.end, target: targets[2], edge: 'end' },
      ...targets.slice(3).map((target) => ({
        delta: target.value - edges.center,
        target,
        edge: 'center',
      })),
    ];

    let best: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      if (Math.abs(candidate.delta) > thresholdPx) continue;
      if (!best || Math.abs(candidate.delta) < Math.abs(best.delta)) {
        best = candidate;
      }
    }

    if (!best) return current;
    guides.push({ axis, position: best.target.value, kind: best.target.kind });
    if (best.edge === 'start') return current + best.delta;
    if (best.edge === 'end') return current + best.delta;
    return current + best.delta;
  };

  x = pickBestSnap(x, width, xTargets, 'x', {
    start: x,
    center: centerX,
    end: right,
  });
  y = pickBestSnap(y, height, yTargets, 'y', {
    start: y,
    center: centerY,
    end: bottom,
  });

  return { rect: { x, y, width, height }, guides };
}

export function clampPixelRectToCanvas(
  rect: PixelRect,
  canvas: CanvasSize,
  minVisiblePx = 1,
): PixelRect {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const x = Math.min(
    Math.max(rect.x, -(width - minVisiblePx)),
    canvas.width - minVisiblePx,
  );
  const y = Math.min(
    Math.max(rect.y, -(height - minVisiblePx)),
    canvas.height - minVisiblePx,
  );
  return { x, y, width, height };
}

export function isPixelRectOffCanvas(rect: PixelRect, canvas: CanvasSize): boolean {
  return (
    rect.x + rect.width <= 0 ||
    rect.x >= canvas.width ||
    rect.y + rect.height <= 0 ||
    rect.y >= canvas.height
  );
}

export function pointInRect(px: number, py: number, rect: PixelRect): boolean {
  return (
    px >= rect.x &&
    px <= rect.x + rect.width &&
    py >= rect.y &&
    py <= rect.y + rect.height
  );
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

const HANDLE_SIZE_PX = 8;

export function hitTestResizeHandle(
  px: number,
  py: number,
  rect: PixelRect,
  handleSize = HANDLE_SIZE_PX,
): ResizeHandle | null {
  const half = handleSize / 2;
  const corners: Array<{ handle: ResizeHandle; cx: number; cy: number }> = [
    { handle: 'nw', cx: rect.x, cy: rect.y },
    { handle: 'ne', cx: rect.x + rect.width, cy: rect.y },
    { handle: 'sw', cx: rect.x, cy: rect.y + rect.height },
    { handle: 'se', cx: rect.x + rect.width, cy: rect.y + rect.height },
  ];
  for (const corner of corners) {
    if (
      px >= corner.cx - half &&
      px <= corner.cx + half &&
      py >= corner.cy - half &&
      py <= corner.cy + half
    ) {
      return corner.handle;
    }
  }
  return null;
}

export function clipLayoutToDisplayPixels(
  clip: Pick<Clip, 'x' | 'y' | 'width' | 'height' | 'videoWidth' | 'videoHeight'>,
  canvas: CanvasSize,
): { x: number; y: number; width: number; height: number } {
  const pixels = resolveClipLayoutPixels(clip, canvas);
  return {
    x: Math.round(pixels.x),
    y: Math.round(pixels.y),
    width: clip.width && clip.width > 0 ? Math.round(pixels.width) : 0,
    height: clip.height && clip.height > 0 ? Math.round(pixels.height) : 0,
  };
}

export function clipDisplayPixelsToNormalized(
  pixels: { x: number; y: number; width: number; height: number },
  canvas: CanvasSize,
): Pick<Clip, 'x' | 'y' | 'width' | 'height'> {
  return clipLayoutPixelsToNormalized(pixels, canvas, true);
}

export function textOverlayToDisplayPixels(
  overlay: Pick<TextOverlay, 'x' | 'y'>,
  canvas: CanvasSize,
): { x: number; y: number } {
  const pixels = resolveTextOverlayPixels(overlay, canvas);
  return { x: Math.round(pixels.x), y: Math.round(pixels.y) };
}

export function textOverlayDisplayPixelsToNormalized(
  pixels: { x: number; y: number },
  canvas: CanvasSize,
): Pick<TextOverlay, 'x' | 'y'> {
  return textOverlayPixelsToNormalized(pixels, canvas);
}

export function layoutNormToPixelValue(
  prop: 'x' | 'y' | 'width' | 'height',
  normValue: number,
  canvas: CanvasSize,
): number {
  if ((prop === 'width' || prop === 'height') && normValue === 0) return 0;
  const dim = prop === 'x' || prop === 'width' ? canvas.width : canvas.height;
  return normValue * dim;
}

export function layoutPixelToNormValue(
  prop: 'x' | 'y' | 'width' | 'height',
  pixelValue: number,
  canvas: CanvasSize,
): number {
  if ((prop === 'width' || prop === 'height') && pixelValue === 0) return 0;
  const dim = prop === 'x' || prop === 'width' ? canvas.width : canvas.height;
  return pixelValue / dim;
}

export function resizePixelRect(
  rect: PixelRect,
  handle: ResizeHandle,
  pointerX: number,
  pointerY: number,
  constrainAspect: boolean,
  aspectRatio: number,
  minSizePx = 24,
): PixelRect {
  let { x, y, width, height } = rect;
  const right = x + width;
  const bottom = y + height;

  switch (handle) {
    case 'nw':
      x = pointerX;
      y = pointerY;
      width = right - x;
      height = bottom - y;
      break;
    case 'ne':
      y = pointerY;
      width = pointerX - x;
      height = bottom - y;
      break;
    case 'sw':
      x = pointerX;
      width = right - x;
      height = pointerY - y;
      break;
    case 'se':
      width = pointerX - x;
      height = pointerY - y;
      break;
  }

  width = Math.max(minSizePx, width);
  height = Math.max(minSizePx, height);

  if (constrainAspect && aspectRatio > 0) {
    if (width / height > aspectRatio) {
      width = height * aspectRatio;
    } else {
      height = width / aspectRatio;
    }
    if (handle === 'nw' || handle === 'sw') {
      x = right - width;
    }
    if (handle === 'nw' || handle === 'ne') {
      y = bottom - height;
    }
  }

  return { x, y, width, height };
}
