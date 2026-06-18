/**
 * Helpers for text overlays rendered via FFmpeg's `drawtext` filter.
 *
 * `scrollSpeed` is expressed as a percentage of the output video's width
 * crossed per second, rather than a raw px/s value. This keeps the
 * crossing time predictable regardless of output resolution: a value of
 * 20 always takes ~5 seconds to cross the screen, whether rendering at
 * 720p or 4K.
 */

import type { TextOverlay } from '../types';
import { isValidFfmpegColor } from './color';

/** Virtual font filename written to the FFmpeg VFS before rendering. */
export const DRAWTEXT_FONT_FILE = 'roboto.ttf';

/** Default scroll speed: ~5 seconds to cross the screen. */
export const DEFAULT_SCROLL_SPEED = 20;
export const MIN_SCROLL_SPEED = 1;
export const MAX_SCROLL_SPEED = 200;

/**
 * Escape user text for FFmpeg `drawtext`'s `text=` option inside a
 * single-quoted filter value. Handles `\`, `'`, `:`, `,`, `%`, and newlines.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

/** Clamp a scroll speed to a sane, non-zero range. */
export function clampScrollSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCROLL_SPEED;
  return Math.min(MAX_SCROLL_SPEED, Math.max(MIN_SCROLL_SPEED, value));
}

/**
 * Approximate time (in seconds) for the ticker to cross the full screen
 * width, ignoring the text's own width (which adds a small additional
 * amount of travel).
 */
export function estimateScrollCrossingSeconds(scrollSpeed: number): number {
  return 100 / clampScrollSpeed(scrollSpeed);
}

/**
 * Build the `x` expression for a scrolling drawtext overlay: starts just
 * off the right edge of the frame and moves left at `scrollSpeed`% of the
 * frame width `w` per second.
 */
export function buildScrollXExpression(scrollSpeed: number): string {
  const fraction = clampScrollSpeed(scrollSpeed) / 100;
  return `w+tw-(t*w*${fraction.toFixed(4)})`;
}

/**
 * Numeric counterpart of {@link buildScrollXExpression} for live preview:
 * the left edge of scrolling text at output time `t`, in pixels. Mirrors
 * FFmpeg's `w+tw-(t*w*fraction)` so the ticker starts fully off the right
 * edge (`textWidth` accounts for its own width) and crosses at the same rate
 * as the export. Pass `textWidth = 0` for a width-agnostic approximation.
 */
export function resolveScrollingX(
  scrollSpeed: number,
  time: number,
  frameWidth: number,
  textWidth = 0,
): number {
  const fraction = clampScrollSpeed(scrollSpeed) / 100;
  return frameWidth + textWidth - time * frameWidth * fraction;
}

/**
 * Build a single `drawtext=...` filter expression for one TextOverlay.
 * User text is escaped before being embedded in the filter graph.
 */
export function buildDrawtextFilter(
  overlay: TextOverlay,
  fontFile: string = DRAWTEXT_FONT_FILE,
): string {
  if (!isValidFfmpegColor(overlay.fontcolor)) {
    throw new Error(
      `Text overlay "${overlay.text.slice(0, 20)}" has an invalid font color: "${overlay.fontcolor}". ` +
        `Use a named color (e.g. "white"), "#RRGGBB", or "0xRRGGBB".`,
    );
  }
  if (overlay.box && !isValidFfmpegColor(overlay.boxColor)) {
    throw new Error(
      `Text overlay "${overlay.text.slice(0, 20)}" has an invalid box color: "${overlay.boxColor}". ` +
        `Use a named color (e.g. "black@0.5"), "#RRGGBB", or "0xRRGGBB", optionally with "@alpha".`,
    );
  }

  const x = overlay.scrolling
    ? buildScrollXExpression(overlay.scrollSpeed)
    : String(overlay.x);

  const parts: string[] = [
    `fontfile=${fontFile}`,
    `text='${escapeDrawtext(overlay.text)}'`,
    `x=${x}`,
    `y=${overlay.y}`,
    `fontsize=${overlay.fontsize}`,
    `fontcolor=${overlay.fontcolor}`,
  ];

  if (overlay.box) {
    parts.push(`box=1`, `boxcolor=${overlay.boxColor}`);
  }

  return `drawtext=${parts.join(':')}`;
}
