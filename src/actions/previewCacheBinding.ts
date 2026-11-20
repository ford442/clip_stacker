/**
 * The RAM preview's commands, bound by the preview (`usePreviewCacheControls`)
 * while it is mounted, for callers below the component layer: the
 * `?test_harness` (`window.clipStacker.test.previewCache`).
 */

import type { PreviewCacheSnapshot } from '../composition/previewCompositionTypes';

export interface PreviewRangeRenderStats {
  frames: number;
  hits: number;
  misses: number;
}

export const previewCacheBinding: {
  /** Render output seconds [from, to) into the RAM preview. */
  renderRange: ((from: number, to: number) => Promise<PreviewRangeRenderStats>) | null;
  /** What the worker holds for the timeline as it is now. */
  status: (() => Promise<PreviewCacheSnapshot | null>) | null;
} = { renderRange: null, status: null };
