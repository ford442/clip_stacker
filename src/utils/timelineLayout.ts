/** Default horizontal scale: pixels per second of timeline content. */
export const DEFAULT_PIXELS_PER_SECOND = 48;
export const MIN_PIXELS_PER_SECOND = 12;
export const MAX_PIXELS_PER_SECOND = 240;

/** Minimum clip block width so very short clips stay clickable. */
export const MIN_CLIP_PIXEL_WIDTH = 48;

/** Format seconds as Ns or m:ss for ruler labels. */
export function formatTimelineTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/** Choose a human-friendly tick interval (seconds) for the given total duration. */
export function rulerTickInterval(totalDuration: number): number {
  if (totalDuration <= 15) return 1;
  if (totalDuration <= 60) return 5;
  if (totalDuration <= 300) return 15;
  if (totalDuration <= 600) return 30;
  return 60;
}

/** Build absolute tick positions (seconds) from 0 through totalDuration. */
export function buildRulerTicks(totalDuration: number, interval: number): number[] {
  if (totalDuration <= 0 || interval <= 0) return [0];
  const ticks: number[] = [0];
  for (let t = interval; t < totalDuration - 0.01; t += interval) {
    ticks.push(t);
  }
  if (totalDuration > 0.01) ticks.push(totalDuration);
  return ticks;
}

/** Clip width in pixels from duration and zoom scale. */
export function clipPixelWidth(durationSeconds: number, pixelsPerSecond: number): number {
  return Math.max(MIN_CLIP_PIXEL_WIDTH, durationSeconds * pixelsPerSecond);
}

/** Total timeline content width in pixels. */
export function timelineContentWidth(totalDuration: number, pixelsPerSecond: number): number {
  return Math.max(MIN_CLIP_PIXEL_WIDTH, totalDuration * pixelsPerSecond);
}

export function clampPixelsPerSecond(value: number): number {
  return Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, value));
}
