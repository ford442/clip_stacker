/**
 * Canvas2D compositing functions for rendering video layers and text overlays.
 */

import type { PreviewCompositionPlan } from './previewComposition';
import type { FrameSource } from './canvas-renderer-types';
import { drawClipLayer, drawTextLayer } from './canvas-renderer-layers';

/**
 * Composite one frame of a preview plan's *video* layers onto a 2D context.
 *
 * `frameSources` provides the decoded image (typically a seeked <video>) for
 * each clip layer, keyed by `clipId`. Clip layers whose source is missing are
 * skipped. Text overlays are NOT drawn here — they are a separate final pass
 * (see {@link drawTextOverlays}) so they can render identically on top of the
 * WebGPU or Canvas2D video composite.
 */
export function compositeFrame(
  ctx: CanvasRenderingContext2D,
  plan: PreviewCompositionPlan,
  frameSources: ReadonlyMap<string, FrameSource>,
): void {
  const { canvasWidth, canvasHeight } = plan;

  // Letterbox background (also clears the previous frame).
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  for (const layer of plan.layers) {
    if (layer.kind === "text") continue;
    const source = frameSources.get(layer.clipId);
    if (!source) continue;
    drawClipLayer(ctx, layer, source);
  }
}

/**
 * Final compositing pass: draw a plan's text overlays onto a 2D context. Used
 * for both preview backends — the WebGPU path draws onto a stacked overlay
 * canvas, the Canvas2D path onto the same overlay canvas above its video
 * composite. Does not clear the context (the caller owns the surface).
 */
export function drawTextOverlays(
  ctx: CanvasRenderingContext2D,
  plan: PreviewCompositionPlan,
): void {
  for (const layer of plan.layers) {
    if (layer.kind !== "text") continue;
    drawTextLayer(ctx, layer, plan.globalTime, plan.canvasWidth, plan.scale);
  }
}

/**
 * Resize a dedicated 2D overlay canvas to the plan's dimensions, clear it, and
 * render the text overlays. The canvas is expected to be stacked transparently
 * over the video composite canvas.
 */
export function renderTextOverlayCanvas(
  canvas: HTMLCanvasElement,
  plan: PreviewCompositionPlan,
): void {
  if (canvas.width !== plan.canvasWidth) canvas.width = plan.canvasWidth;
  if (canvas.height !== plan.canvasHeight) canvas.height = plan.canvasHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTextOverlays(ctx, plan);
}

/**
 * Async variant that supports shader-filled overlays.
 * For 'solid' overlays it uses the fast 2D path. For 'shader' overlays it
 * uses the WebGPU text fill renderer (when available) to produce matching
 * procedural results for preview and export.
 */
export async function renderTextOverlaysAsync(
  canvas: HTMLCanvasElement,
  plan: PreviewCompositionPlan,
): Promise<void> {
  if (canvas.width !== plan.canvasWidth) canvas.width = plan.canvasWidth;
  if (canvas.height !== plan.canvasHeight) canvas.height = plan.canvasHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Quick path: no shader fills -> existing behavior
  const hasShader = plan.layers.some(
    (l: any) => l.kind === 'text' && (l.overlay as any)?.fill === 'shader',
  );
  if (!hasShader) {
    drawTextOverlays(ctx, plan);
    return;
  }

  // Mixed path: draw solid and shader layers appropriately.
  // We draw box rects (flat) for all, then glyphs via solid or GPU fill.
  const { sanitizeFfmpegColor, ffmpegColorToCss } = await import('./color');
  const { getBundledFont, resolveScrollingX } = await import('./textOverlay');

  const DEFAULT_BOX_COLOR = "black@0.5";

  for (const layer of plan.layers) {
    if (layer.kind !== 'text') continue;
    const overlay = (layer as any).overlay as import('../types').TextOverlay;
    if (!overlay || !overlay.text) continue;

    const useShader = overlay.fill === 'shader';
    // Draw box first (flat color) if requested — same for both modes.
    if (overlay.box) {
      const { color, alpha } = ffmpegColorToCss(
        sanitizeFfmpegColor(overlay.boxColor, DEFAULT_BOX_COLOR),
      );
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = Math.max(0, Math.min(1, (layer as any).opacity ?? 1)) * alpha;
      const fs = overlay.fontsize * plan.scale;
      const pad = Math.round(fs * 0.2);
      // Approximate text width using current font for box sizing (best effort)
      const family = getBundledFont(overlay.font).familyName;
      ctx.font = `${fs}px "${family}"`;
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(overlay.text).width;
      const x = (overlay as any).scrolling
        ? resolveScrollingX(overlay.scrollSpeed, plan.globalTime, plan.canvasWidth, tw)
        : (layer as any).x;
      ctx.fillStyle = color;
      ctx.fillRect(x - pad, (layer as any).y - pad, tw + pad * 2, fs + pad * 2);
      ctx.globalAlpha = prev;
    }

    if (useShader) {
      // GPU fill path
      try {
        const { getTextFillRenderer } = await import('../webgpu/text/textFill');
        const renderer = await getTextFillRenderer();
        // Build a mask for just this overlay at plan res
        const { createSingleOverlayGlyphMask } = await import('./textMask');
        const mask = createSingleOverlayGlyphMask(
          overlay,
          plan.globalTime,
          plan.canvasWidth,
          plan.canvasHeight,
        );
        // Identifies this overlay's glyph raster (position/opacity already
        // resolved for this frame by the plan). Unchanged across frames for
        // a static caption, so the renderer skips re-uploading the mask
        // texture — only `time` (the shader animation phase) changes.
        const maskCacheKey = [
          overlay.id,
          overlay.text,
          overlay.font ?? '',
          overlay.fontsize,
          (layer as any).x,
          (layer as any).y,
          (layer as any).opacity ?? 1,
          plan.canvasWidth,
          plan.canvasHeight,
        ].join(':');
        const filled = await renderer.render(mask, {
          time: plan.globalTime,
          shaderId: overlay.shaderId,
          params: overlay.shaderParams,
          colors: overlay.shaderColors,
          width: plan.canvasWidth,
          height: plan.canvasHeight,
          maskCacheKey,
        });
        // Draw the filled glyphs at full opacity for the layer (opacity baked in mask or fill)
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = Math.max(0, Math.min(1, (layer as any).opacity ?? 1));
        ctx.drawImage(filled, 0, 0);
        ctx.globalAlpha = prev;
      } catch {
        // Fallback to solid if GPU path fails
        drawTextLayer(ctx, layer as any, plan.globalTime, plan.canvasWidth, plan.scale);
      }
    } else {
      // Solid path reuses existing per-layer draw (color + alpha)
      drawTextLayer(ctx, layer as any, plan.globalTime, plan.canvasWidth, plan.scale);
    }
  }
}
