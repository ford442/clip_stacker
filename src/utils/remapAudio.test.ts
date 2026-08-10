import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { buildSourceOffsetMap, scheduleNeedsRateRemap } from './remapAudio';
import { remappedClipDuration } from './timeRemap';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File([], 'a.mp4'),
    objectUrl: 'blob:a',
    title: 'a',
    kind: 'video',
    duration: 2,
    trimStart: 0,
    trimEnd: 2,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('remapAudio', () => {
  it('flags rate automation for remapping', () => {
    expect(scheduleNeedsRateRemap(makeClip())).toBe(false);
    expect(
      scheduleNeedsRateRemap(
        makeClip({
          automation: { playbackRate: [{ t: 0, value: 1 }, { t: 1, value: 2 }] },
        }),
      ),
    ).toBe(true);
  });

  it('builds a monotonic source-offset map for a speed ramp', () => {
    const clip = makeClip({
      automation: {
        playbackRate: [
          { t: 0, value: 1 },
          { t: 1, value: 3 },
        ],
      },
    });
    const outSec = remappedClipDuration(clip);
    const sr = 1000;
    const hop = 100;
    const outFrames = Math.floor(outSec * sr);
    const offsets = buildSourceOffsetMap(clip, outFrames, sr, hop);
    expect(offsets.length).toBeGreaterThan(2);
    expect(offsets[0]).toBeCloseTo(0, 0);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] - 1e-3);
    }
  });
});
