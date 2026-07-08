import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import { canUseGpuVideoEncoder } from './renderEligibility';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    file: new File([], 'clip-1.mp4'),
    objectUrl: 'blob:clip-1',
    title: 'Clip 1',
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('renderEligibility', () => {
  it('allows GPU export for simple stacks', () => {
    expect(canUseGpuVideoEncoder([makeClip()], [], [])).toBe(true);
  });

  it('blocks GPU export for transitions when WebGPU is unavailable', () => {
    expect(
      canUseGpuVideoEncoder(
        [makeClip()],
        [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }],
        [],
      ),
    ).toBe(false);
    expect(
      canUseGpuVideoEncoder(
        [makeClip()],
        [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }],
        [],
        { webGpuAvailable: true },
      ),
    ).toBe(true);
    expect(canUseGpuVideoEncoder([makeClip({ layerIndex: 1 })], [], [])).toBe(
      false,
    );
    expect(
      canUseGpuVideoEncoder([makeClip({ layerIndex: 1 })], [], [], {
        webGpuAvailable: true,
      }),
    ).toBe(true);
  });

  it('allows GPU timeline export when keyframes are present', () => {
    expect(
      canUseGpuVideoEncoder(
        [
          makeClip({
            keyframes: {
              opacity: [
                { t: 0, value: 1 },
                { t: 2, value: 0.5 },
              ],
            },
          }),
        ],
        [],
        [],
        { webGpuAvailable: true },
      ),
    ).toBe(true);
  });

  it('requires WebGPU for shader-filled text overlays', () => {
    const ov = {
      id: 't1', text: 'Hi', fontsize: 24, fontcolor: 'white', x: 0, y: 0,
      scrolling: false, scrollSpeed: 20, box: false, boxColor: 'black@0.5',
      fill: 'shader' as const, shaderId: 'gradient',
    };
    // Without webGpuAvailable, cannot use GPU encoder
    expect(canUseGpuVideoEncoder([makeClip()], [], [ov as any])).toBe(false);
    // With webGpuAvailable, allowed (shader forces timeline GPU path)
    expect(
      canUseGpuVideoEncoder([makeClip()], [], [ov as any], { webGpuAvailable: true }),
    ).toBe(true);
  });
});
