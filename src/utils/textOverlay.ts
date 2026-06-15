/**
 * Helpers for the scrolling-ticker text overlay mode.
 *
 * `scrollSpeed` is expressed as a percentage of the output video's width
 * crossed per second, rather than a raw px/s value. This keeps the
 * crossing time predictable regardless of output resolution: a value of
 * 20 always takes ~5 seconds to cross the screen, whether rendering at
 * 720p or 4K.
 */

/** Default scroll speed: ~5 seconds to cross the screen. */
export const DEFAULT_SCROLL_SPEED = 20;
export const MIN_SCROLL_SPEED = 1;
export const MAX_SCROLL_SPEED = 200;

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
