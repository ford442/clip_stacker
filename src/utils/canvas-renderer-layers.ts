/**
 * Layer drawing functions for the Canvas2D compositor.
 */

import type { PreviewClipLayer, PreviewTextLayer } from './previewComposition';
import type { FrameSource } from './canvas-renderer-types';
import { ffmpegColorToCss, sanitizeFfmpegColor } from './color';
import { getBundledFont, resolveScrollingX } from './textOverlay';
import {
  combineLetterboxWithLayerUv,
  computeLetterboxUv,
  uvRectToSourcePixels,
} from '../webgpu/exportCompositor';
import { calculateLetterboxRect, clampOpacity } from './canvas-renderer-helpers';
import { isIdentityStabMatrix, stabMatrixToCanvasTransform } from './stabilization';

// Default fallbacks when an overlay carries an invalid FFmpeg color.
const DEFAULT_FONT_COLOR = "white";
const DEFAULT_BOX_COLOR = "black@0.5";

/** Draw one clip layer onto the 2D context. */
export function drawClipLayer(
  ctx: CanvasRenderingContext2D,
  layer: PreviewClipLayer,
  source: FrameSource,
): void {
  const destWidth = layer.rect.width;
  const destHeight = layer.rect.height;
  const srcW = source.width || destWidth;
  const srcH = source.height || destHeight;

  const letterbox = computeLetterboxUv(srcW, srcH, destWidth, destHeight);
  const uv = combineLetterboxWithLayerUv(letterbox, layer.uvScale, layer.uvOffset);
  const crop = uvRectToSourcePixels(srcW, srcH, uv);

  const inner = calculateLetterboxRect(srcW, srcH, destWidth, destHeight);
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = clampOpacity(layer.opacity);

  // Camera-shake correction. drawImage's crop rectangle can only translate and
  // scale, so the rotation component has to ride on the context transform;
  // the stored matrix is an inverse warp, hence the flip to a forward one.
  const stab = layer.stabMatrix;
  const warped = Boolean(stab) && !isIdentityStabMatrix(stab!);
  const originX = layer.rect.x + inner.x;
  const originY = layer.rect.y + inner.y;
  if (warped) {
    const t = stabMatrixToCanvasTransform(stab!, inner.width, inner.height);
    ctx.save();
    ctx.translate(originX, originY);
    ctx.transform(t[0], t[3], t[1], t[4], t[2], t[5]);
    ctx.translate(-originX, -originY);
  }

  ctx.drawImage(
    source.image,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    originX,
    originY,
    inner.width,
    inner.height,
  );
  if (warped) ctx.restore();
  ctx.globalAlpha = prevAlpha;
}

/** Draw one text overlay (box + glyphs) onto the 2D context. */
export function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  layer: PreviewTextLayer,
  globalTime: number,
  frameWidth: number,
  scale: number,
): void {
  const overlay = layer.overlay;
  if (!overlay.text) return;

  const prevAlpha = ctx.globalAlpha;
  const baseAlpha = clampOpacity(layer.opacity);
  // Font size is authored in output space; scale it to match a downscaled
  // preview canvas (layer.x/y are already scaled by the plan).
  const fontsize = overlay.fontsize * scale;
  ctx.textBaseline = "top";
  const family = getBundledFont(overlay.font).familyName;
  // Quote the family to be safe with names containing spaces.
  ctx.font = `${fontsize}px "${family}"`;

  const textWidth = ctx.measureText(overlay.text).width;
  const textHeight = fontsize;

  // Static overlays use the plan's x; scrolling ones are recomputed here with
  // the measured text width so the ticker start matches the export path.
  const x = overlay.scrolling
    ? resolveScrollingX(overlay.scrollSpeed, globalTime, frameWidth, textWidth)
    : layer.x;

  if (overlay.box) {
    const { color, alpha } = ffmpegColorToCss(
      sanitizeFfmpegColor(overlay.boxColor, DEFAULT_BOX_COLOR),
    );
    const pad = Math.round(fontsize * 0.2);
    ctx.globalAlpha = clampOpacity(baseAlpha * alpha);
    ctx.fillStyle = color;
    ctx.fillRect(
      x - pad,
      layer.y - pad,
      textWidth + pad * 2,
      textHeight + pad * 2,
    );
  }

  const { color, alpha } = ffmpegColorToCss(
    sanitizeFfmpegColor(overlay.fontcolor, DEFAULT_FONT_COLOR),
  );
  ctx.globalAlpha = clampOpacity(baseAlpha * alpha);
  ctx.fillStyle = color;
  ctx.fillText(overlay.text, x, layer.y);
  ctx.globalAlpha = prevAlpha;
}
