/**
 * Text mask utilities.
 *
 * Rasterizes TextOverlay glyphs into an alpha mask using Canvas 2D at the
 * target composition resolution. The mask contains white text (or opaque
 * coverage) on a transparent background; only glyph coverage is present.
 * Boxes are intentionally omitted — they are composited as flat layers.
 *
 * Scrolling and keyframed x/y/opacity are respected via the same layout
 * helpers used by the preview composition and 2D overlay drawing.
 */

import type { TextOverlay } from '../types';
import {
  buildPreviewCompositionPlan,
  type PreviewCompositionPlan,
  type PreviewTextLayer,
} from './previewComposition';
import { getBundledFont } from './textOverlay';
import { resolveScrollingX } from './textOverlay';
import { ffmpegColorToCss, sanitizeFfmpegColor } from './color';
import { resolveAnimatedTextLayout } from './animatedLayout';

const DEFAULT_FONT_COLOR = 'white';
const DEFAULT_BOX_COLOR = 'black@0.5';

/** Create a canvas containing only glyph alphas for the given overlays at t. */
export function createTextGlyphMask(
  overlays: TextOverlay[],
  globalTime: number,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  // Use a minimal plan to get consistent layer positions (it applies keyframe
  // animation and scrolling math at the target geometry).
  // We pass empty clips/transitions so only text layers are produced.
  const plan = buildPreviewCompositionPlan(
    [],
    [],
    [],
    overlays,
    undefined,
    globalTime,
    height,
    width,
  );

  drawGlyphMask(ctx, plan);
  return canvas;
}

/**
 * Draw glyph coverage (white) for text layers in the plan into ctx.
 * Does not clear; caller owns the surface. No box rects are drawn.
 */
export function drawGlyphMask(
  ctx: CanvasRenderingContext2D,
  plan: PreviewCompositionPlan,
): void {
  for (const layer of plan.layers) {
    if (layer.kind !== 'text') continue;
    drawGlyphMaskLayer(ctx, layer, plan.globalTime, plan.canvasWidth, plan.scale);
  }
}

function drawGlyphMaskLayer(
  ctx: CanvasRenderingContext2D,
  layer: PreviewTextLayer,
  globalTime: number,
  frameWidth: number,
  scale: number,
): void {
  const overlay = layer.overlay;
  if (!overlay.text) return;

  const prevAlpha = ctx.globalAlpha;
  const baseAlpha = Math.max(0, Math.min(1, layer.opacity));

  const fontsize = overlay.fontsize * scale;
  ctx.textBaseline = 'top';

  const family = getBundledFont(overlay.font).familyName;
  ctx.font = `${fontsize}px "${family}"`;

  const textWidth = ctx.measureText(overlay.text).width;

  const x = overlay.scrolling
    ? resolveScrollingX(overlay.scrollSpeed, globalTime, frameWidth, textWidth)
    : layer.x;

  // Draw only the glyph mask as opaque white where text is. Use baseAlpha so
  // keyframed opacity affects coverage strength (multiplied later by fill).
  ctx.globalAlpha = baseAlpha;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(overlay.text, x, layer.y);

  ctx.globalAlpha = prevAlpha;
}

/**
 * Helper to produce a mask for a single overlay at a given time, using the
 * same animated layout math as the composition planner. Useful for unit tests.
 */
export function createSingleOverlayGlyphMask(
  overlay: TextOverlay,
  globalTime: number,
  width: number,
  height: number,
): HTMLCanvasElement {
  // Build a tiny plan with just this overlay to get resolved x/y/scale.
  const plan = buildPreviewCompositionPlan(
    [],
    [],
    [],
    [overlay],
    undefined,
    globalTime,
    height,
    width,
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(plan.canvasWidth));
  canvas.height = Math.max(1, Math.floor(plan.canvasHeight));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;
  drawGlyphMask(ctx, plan);
  return canvas;
}
