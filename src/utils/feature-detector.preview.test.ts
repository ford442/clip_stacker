import { describe, it, expect } from 'vitest';
import {
  previewBackendLabel,
  selectPreviewBackend,
  WEBGPU_LAYER_BUDGET,
} from './feature-detector';

describe('selectPreviewBackend', () => {
  it('prefers WebGPU when available and within the layer budget', () => {
    expect(selectPreviewBackend({ webgpu: true })).toBe('webgpu');
    expect(selectPreviewBackend({ webgpu: true }, WEBGPU_LAYER_BUDGET)).toBe(
      'webgpu',
    );
  });

  it('falls back to Canvas2D when the plan exceeds the WebGPU layer budget', () => {
    expect(
      selectPreviewBackend({ webgpu: true }, WEBGPU_LAYER_BUDGET + 1),
    ).toBe('canvas2d');
  });

  it('hard-fails when WebGPU is unavailable (Canvas2D is not a GPU fallback)', () => {
    expect(selectPreviewBackend({ webgpu: false })).toBe('unavailable');
  });

  it('reports unavailable only when WebGPU cannot run (or 2D is missing over budget)', () => {
    expect(selectPreviewBackend({ webgpu: false }, 0, false)).toBe(
      'unavailable',
    );
    expect(
      selectPreviewBackend({ webgpu: true }, WEBGPU_LAYER_BUDGET + 1, false),
    ).toBe('unavailable');
  });
});

describe('previewBackendLabel', () => {
  it('maps each backend to a UI badge label', () => {
    expect(previewBackendLabel('webgpu')).toBe('WebGPU Worker');
    expect(previewBackendLabel('canvas2d')).toBe('Canvas2D (layer budget)');
    expect(previewBackendLabel('unavailable')).toBe('GPU preview unavailable');
  });
});
