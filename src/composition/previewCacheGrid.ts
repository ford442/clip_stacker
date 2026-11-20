/**
 * The RAM preview's frame grid, shared by the worker cache and the UI that
 * shows it (kept import-free so the ruler does not pull the cache in).
 */

/** Preview frames snap to the project frame rate while the cache is on (the export grid). */
export const PREVIEW_CACHE_FPS = 30;

/** Sorted frame numbers → `[start, end)` runs. */
export function frameRanges(frames: readonly number[]): Array<[number, number]> {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const frame of sorted) {
    const last = ranges.at(-1);
    if (last && last[1] === frame) last[1] = frame + 1;
    else ranges.push([frame, frame + 1]);
  }
  return ranges;
}
