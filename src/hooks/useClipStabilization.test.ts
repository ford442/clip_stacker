import { describe, expect, it } from 'vitest';
import { setClipStabilize } from './useClipStabilization';
import { createTestClip } from '../utils/project.test.helpers';
import type { ClipStabilization } from '../types';

const STABILIZATION: ClipStabilization = {
  fps: 24,
  matrices: new Float32Array([1, 0, 0, 0, 1, 0]),
  frameCount: 1,
  zoom: 1.05,
  maxCorrection: 0.02,
  smoothRadius: 24,
};

describe('setClipStabilize', () => {
  it('turns the toggle on and clears a stale failure', () => {
    const next = setClipStabilize(
      { ...createTestClip('a', 5), stabilizeError: 'decode failed' },
      true,
    );
    expect(next.stabilize).toBe(true);
    expect(next.stabilizeError).toBeUndefined();
  });

  it('keeps the computed matrices when switching off', () => {
    const on = { ...createTestClip('a', 5), stabilize: true, stabilization: STABILIZATION };
    const off = setClipStabilize(on, false);
    expect(off.stabilize).toBe(false);
    // Re-enabling must not pay for a second analysis pass.
    expect(off.stabilization).toBe(STABILIZATION);
    expect(setClipStabilize(off, true).stabilization).toBe(STABILIZATION);
  });

  it('does not mutate the clip it is given', () => {
    const clip = createTestClip('a', 5);
    const next = setClipStabilize(clip, true);
    expect(clip.stabilize).toBeUndefined();
    expect(next).not.toBe(clip);
  });
});
