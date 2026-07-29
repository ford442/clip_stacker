import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import { snapTimeToBeat, snapSplitTimeToBeat } from './beatSnap';

function makeClip(beats: number[]): Clip {
  return {
    id: 'c1',
    file: new File([], 'c1.mp4'),
    objectUrl: 'blob:c1',
    title: 'c1',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    beatTimestamps: beats,
  };
}

describe('beatSnap', () => {
  it('snapTimeToBeat returns nearest beat within threshold', () => {
    expect(snapTimeToBeat(1.02, [1.0, 2.0], 100)).toBe(1.0);
    expect(snapTimeToBeat(1.2, [1.0, 2.0], 100)).toBeNull();
  });

  it('snapSplitTimeToBeat snaps split to beat in trim window', () => {
    const clip = makeClip([0.5, 1.0, 1.5, 2.0]);
    expect(snapSplitTimeToBeat(clip, 1.04, 100)).toBe(1.0);
    expect(snapSplitTimeToBeat(clip, 1.3, 100)).toBe(1.3);
  });

  it('no-ops when beatTimestamps absent', () => {
    const clip = makeClip([]);
    expect(snapSplitTimeToBeat(clip, 1.5)).toBe(1.5);
  });
});
