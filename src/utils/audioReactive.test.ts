import { describe, expect, it } from 'vitest';
import {
  AUDIO_UNIFORM_OFFSET,
  PREVIEW_UNIFORM_FLOATS,
  ZERO_AUDIO_REACTIVE,
} from '../wasm/audioReactiveUniforms';
import { bassLevelFromAnalyserBytes, bassLevelFromWasmBands } from './canvas-renderer';

describe('audio reactive helpers', () => {
  it('documents uniform slot layout for WGSL', () => {
    expect(PREVIEW_UNIFORM_FLOATS).toBe(20);
    expect(AUDIO_UNIFORM_OFFSET.bass).toBe(13);
    expect(AUDIO_UNIFORM_OFFSET.beat).toBe(16);
    expect(ZERO_AUDIO_REACTIVE.bass).toBe(0);
  });

  it('computes bass from analyser bytes and wasm bands', () => {
    const bytes = new Uint8Array([255, 255, 0, 0, 0, 0, 0, 0]);
    // bassEnd = length/4 = 2 → average of first two bins
    expect(bassLevelFromAnalyserBytes(bytes)).toBeCloseTo(1, 5);
    expect(bassLevelFromWasmBands([0.8, 0.4, 0, 0, 0, 0, 0, 0])).toBeCloseTo(0.6, 5);
    expect(bassLevelFromWasmBands([], 0.33)).toBeCloseTo(0.33, 5);
  });
});
