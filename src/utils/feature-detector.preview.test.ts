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

  it('falls back to Canvas2D when WebGPU is unavailable', () => {
    expect(selectPreviewBackend({ webgpu: false })).toBe('canvas2d');
  });

  it('reports unavailable only when neither backend can run', () => {
    expect(selectPreviewBackend({ webgpu: false }, 0, false)).toBe(
      'unavailable',
    );
  });
});

describe('previewBackendLabel', () => {
  it('maps each backend to a UI badge label', () => {
    expect(previewBackendLabel('webgpu')).toBe('WebGPU Timeline');
    expect(previewBackendLabel('canvas2d')).toBe('Canvas2D Timeline');
    expect(previewBackendLabel('unavailable')).toBe('Preview unavailable');
  });
});
