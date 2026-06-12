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

  it('blocks GPU export for transitions and PiP', () => {
    expect(
      canUseGpuVideoEncoder(
        [makeClip()],
        [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }],
        [],
      ),
    ).toBe(false);
    expect(canUseGpuVideoEncoder([makeClip({ layerIndex: 1 })], [], [])).toBe(false);
  });
});
