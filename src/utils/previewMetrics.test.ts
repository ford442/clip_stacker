import { describe, expect, it } from 'vitest';
import { PreviewMetrics } from './previewMetrics';

describe('PreviewMetrics frame sources', () => {
  it('splits layers into proxy and original', () => {
    const metrics = new PreviewMetrics();
    metrics.setFrameSources({ decoder: 3, element: 1, proxy: 2 });
    const s = metrics.snapshot();
    expect(s.proxySourcedLayers).toBe(2);
    expect(s.originalSourcedLayers).toBe(2);
    expect(s.elementSourcedLayers).toBe(1);
  });

  it('treats a sender without proxy counts as all-original', () => {
    const metrics = new PreviewMetrics();
    metrics.setFrameSources({ decoder: 2, element: 0 });
    expect(metrics.snapshot()).toMatchObject({ proxySourcedLayers: 0, originalSourcedLayers: 2 });
  });

  it('resets proxy counts', () => {
    const metrics = new PreviewMetrics();
    metrics.setFrameSources({ decoder: 1, element: 0, proxy: 1 });
    metrics.reset();
    expect(metrics.snapshot().proxySourcedLayers).toBe(0);
  });
});
