import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

/**
 * RAM-preview view state: the In / Out marks, which frames the preview cache
 * holds (the ruler's green bar), and the Render In→Out job. Never in a
 * project or undo history. The preview (`hooks/usePreviewCacheControls.ts`)
 * runs the job and reports the cached ranges; the ruler, the timeline chrome
 * and the shortcuts only read and request.
 */

/** A `[start, end)` run of frame numbers on the 30 fps grid. */
export type FrameRange = [number, number];

export interface PreviewRenderJob {
  done: number;
  total: number;
}

export interface PreviewCacheState {
  /** Output seconds, or null when unset. */
  inPoint: number | null;
  outPoint: number | null;
  /** Cached frames of the timeline as it is now. */
  cachedRanges: FrameRange[];
  /** The running Render In→Out, or null. */
  job: PreviewRenderJob | null;
  /** Bumped to ask the preview to render In→Out / to stop it. */
  renderRequest: number;
  cancelRequest: number;
  /** Bumped to ask the preview to drop its frames. */
  clearRequest: number;
  setInPoint: (seconds: number | null) => void;
  setOutPoint: (seconds: number | null) => void;
  clearMarks: () => void;
  setCachedRanges: (ranges: FrameRange[]) => void;
  setJob: (job: PreviewRenderJob | null) => void;
  requestRender: () => void;
  requestCancel: () => void;
  requestClear: () => void;
}

/** The marked range in order, or null without both marks (or an empty range). */
export function markedRange(state: Pick<PreviewCacheState, 'inPoint' | 'outPoint'>): [number, number] | null {
  const { inPoint, outPoint } = state;
  if (inPoint === null || outPoint === null) return null;
  const start = Math.min(inPoint, outPoint);
  const end = Math.max(inPoint, outPoint);
  return end > start ? [start, end] : null;
}

const sameRanges = (a: FrameRange[], b: FrameRange[]) =>
  a.length === b.length && a.every((range, i) => range[0] === b[i]![0] && range[1] === b[i]![1]);

export const previewCacheStore = createStore<PreviewCacheState>()((set, get) => ({
  inPoint: null,
  outPoint: null,
  cachedRanges: [],
  job: null,
  renderRequest: 0,
  cancelRequest: 0,
  clearRequest: 0,
  setInPoint: (inPoint) => set({ inPoint: inPoint === null ? null : Math.max(0, inPoint) }),
  setOutPoint: (outPoint) => set({ outPoint: outPoint === null ? null : Math.max(0, outPoint) }),
  clearMarks: () => set({ inPoint: null, outPoint: null }),
  setCachedRanges: (cachedRanges) => {
    if (!sameRanges(get().cachedRanges, cachedRanges)) set({ cachedRanges });
  },
  setJob: (job) => set({ job }),
  requestRender: () => set((s) => ({ renderRequest: s.renderRequest + 1 })),
  requestCancel: () => set((s) => ({ cancelRequest: s.cancelRequest + 1 })),
  requestClear: () => set((s) => ({ clearRequest: s.clearRequest + 1, cachedRanges: [] })),
}));

export function usePreviewCacheStore<T>(selector: (s: PreviewCacheState) => T): T {
  return useStore(previewCacheStore, selector);
}
