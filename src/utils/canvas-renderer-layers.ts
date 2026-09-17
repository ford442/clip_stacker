/**
 * Layer drawing functions for the Canvas2D compositor.
 */

import type {
  PreviewCaptionLayer,
  PreviewClipLayer,
  PreviewTextLayer,
} from './previewComposition';
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
import { applyKeyToImageData, KEY_MODE, type LayerKeyUniforms } from './overlayKey';

// Default fallbacks when an overlay carries an invalid FFmpeg color.
const DEFAULT_FONT_COLOR = "white";
const DEFAULT_BOX_COLOR = "black@0.5";

/**
 * Pre-key a frame into a scratch canvas so `drawImage` composites the keyed
 * result. Canvas2D has no per-pixel hook, so the key runs on the CPU here —
 * the same `keyPixel` maths the WGSL shader and FFmpeg use.
 *
 * Keyed on the full source frame rather than the cropped rect because the crop
 * is expressed in source pixels and `drawImage` still reads from this canvas.
 */
const keyScratch = {
  canvas: null as HTMLCanvasElement | null,
  ctx: null as CanvasRenderingContext2D | null,
};

function keyFrameSource(
  source: FrameSource,
  key: LayerKeyUniforms,
): FrameSource {
  const width = source.width;
  const height = source.height;
  if (!width || !height) return source;

  if (!keyScratch.canvas) {
    keyScratch.canvas = document.createElement('canvas');
    keyScratch.ctx = keyScratch.canvas.getContext('2d', {
      willReadFrequently: true,
    });
  }
  const canvas = keyScratch.canvas;
  const ctx = keyScratch.ctx;
  if (!canvas || !ctx) return source;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  try {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source.image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    applyKeyToImageData(imageData.data, key);
    ctx.putImageData(imageData, 0, 0);
  } catch {
    // Tainted canvas or a zero-size frame — fall back to the unkeyed source
    // rather than dropping the layer entirely.
    return source;
  }

  return { image: canvas, width, height };
}

/** Draw one clip layer onto the 2D context. */
export function drawClipLayer(
  ctx: CanvasRenderingContext2D,
  layer: PreviewClipLayer,
  rawSource: FrameSource,
): void {
  const source =
    layer.key && layer.key.mode !== KEY_MODE.none
      ? keyFrameSource(rawSource, layer.key)
      : rawSource;

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

/** Line spacing as a multiple of the font size, matching libass's default. */
const CAPTION_LINE_HEIGHT = 1.2;

/**
 * Draw one caption cue (box + glyphs) onto the 2D context.
 *
 * Captions anchor **bottom-centre** (`layer.x` is the centre, `layer.y` the
 * bottom of the last line), unlike text overlays which anchor top-left — see
 * the note in `AGENTS.md`. Multi-line cues stack upward from `layer.y` so the
 * baseline of the last line stays put as lines are added, which is what the
 * ASS burn-in does with alignment 2.
 */
export function drawCaptionLayer(
  ctx: CanvasRenderingContext2D,
  layer: PreviewCaptionLayer,
  scale: number,
): void {
  if (!layer.text) return;

  const style = layer.style;
  const prevAlpha = ctx.globalAlpha;
  const prevAlign = ctx.textAlign;
  const baseAlpha = clampOpacity(layer.opacity);
  // Font size is authored in output space; scale it to the (possibly capped)
  // preview canvas. layer.x/y are already in canvas pixels.
  const fontsize = style.fontsize * scale;
  const lineHeight = fontsize * CAPTION_LINE_HEIGHT;
  const lines = layer.text.split('\n');

  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  const family = getBundledFont(style.font).familyName;
  ctx.font = `${fontsize}px "${family}"`;

  // Top of the first line: walk up from the bottom anchor by every line.
  const firstLineTop = layer.y - lines.length * lineHeight;

  if (style.box) {
    const { color, alpha } = ffmpegColorToCss(
      sanitizeFfmpegColor(style.boxColor, DEFAULT_BOX_COLOR),
    );
    const pad = Math.round(fontsize * 0.2);
    const widest = lines.reduce(
      (max, line) => Math.max(max, ctx.measureText(line).width),
      0,
    );
    ctx.globalAlpha = clampOpacity(baseAlpha * alpha);
    ctx.fillStyle = color;
    ctx.fillRect(
      layer.x - widest / 2 - pad,
      firstLineTop - pad,
      widest + pad * 2,
      lines.length * lineHeight + pad * 2,
    );
  }

  const { color, alpha } = ffmpegColorToCss(
    sanitizeFfmpegColor(style.fontcolor, DEFAULT_FONT_COLOR),
  );
  ctx.globalAlpha = clampOpacity(baseAlpha * alpha);
  ctx.fillStyle = color;
  for (let index = 0; index < lines.length; index++) {
    ctx.fillText(lines[index], layer.x, firstLineTop + index * lineHeight);
  }

  ctx.globalAlpha = prevAlpha;
  ctx.textAlign = prevAlign;
}
