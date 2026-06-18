import { describe, it, expect } from 'vitest';
import {
  capPreviewResolution,
  evaluatePreviewBudget,
  DEFAULT_PREVIEW_MAX_HEIGHT,
} from './previewBudget';
import { WEBGPU_LAYER_BUDGET } from './feature-detector';

describe('capPreviewResolution', () => {
  it('returns the original size when height is within budget', () => {
    expect(capPreviewResolution(1920, 720)).toEqual({
      width: 1920,
      height: 720,
      scale: 1,
      capped: false,
    });
  });

  it('scales down to max height while preserving aspect ratio', () => {
    const result = capPreviewResolution(3840, 2160, DEFAULT_PREVIEW_MAX_HEIGHT);
    expect(result.height).toBe(DEFAULT_PREVIEW_MAX_HEIGHT);
    expect(result.capped).toBe(true);
    expect(result.scale).toBeCloseTo(DEFAULT_PREVIEW_MAX_HEIGHT / 2160);
    expect(result.width).toBe(Math.round(3840 * result.scale));
  });

  it('returns uncapped for degenerate inputs', () => {
    expect(capPreviewResolution(0, 1080)).toEqual({
      width: 0,
      height: 1080,
      scale: 1,
      capped: false,
    });
  });
});

describe('evaluatePreviewBudget', () => {
  it('returns no message when preview is not degraded', () => {
    expect(
      evaluatePreviewBudget({
        backend: 'webgpu',
        capped: false,
        outputHeight: 720,
        cappedHeight: 720,
        layerCount: 2,
      }),
    ).toEqual({ degraded: false, message: null });
  });

  it('reports resolution capping', () => {
    const result = evaluatePreviewBudget({
      backend: 'webgpu',
      capped: true,
      outputHeight: 2160,
      cappedHeight: 720,
      layerCount: 2,
    });
    expect(result.degraded).toBe(true);
    expect(result.message).toContain('reduced to 720p (from 2160p)');
  });

  it('reports Canvas2D fallback when over the WebGPU layer budget', () => {
    const result = evaluatePreviewBudget({
      backend: 'canvas2d',
      capped: false,
      outputHeight: 720,
      cappedHeight: 720,
      layerCount: WEBGPU_LAYER_BUDGET + 3,
    });
    expect(result.degraded).toBe(true);
    expect(result.message).toContain('Canvas2D');
    expect(result.message).toContain(String(WEBGPU_LAYER_BUDGET));
  });
});
