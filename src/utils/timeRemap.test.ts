import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  clipHasRateAutomation,
  integrateRateToSourceOffset,
  remappedClipDuration,
  samplePlaybackRateAt,
  sourceTimeAtOutputLocal,
} from './timeRemap';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File([], 'a.mp4'),
    objectUrl: 'blob:a',
    title: 'a',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('timeRemap', () => {
  it('integrates constant rate as rate × time', () => {
    expect(integrateRateToSourceOffset(undefined, 2, 5)).toBeCloseTo(10);
    expect(integrateRateToSourceOffset([{ t: 0, value: 0.5 }], 1, 4)).toBeCloseTo(2);
  });

  it('integrates a linear speed ramp analytically', () => {
    // rate 1→3 over 0..2: ∫ (1 + t) dt from 0..2 = [t + t²/2]_0^2 = 2+2 = 4
    const track = [
      { t: 0, value: 1 },
      { t: 2, value: 3 },
    ];
    expect(integrateRateToSourceOffset(track, 1, 2)).toBeCloseTo(4);
    expect(integrateRateToSourceOffset(track, 1, 1)).toBeCloseTo(1.5);
  });

  it('maps output-local time to source time with ramp', () => {
    const clip = makeClip({
      trimStart: 1,
      automation: {
        playbackRate: [
          { t: 0, value: 1 },
          { t: 2, value: 3 },
        ],
      },
    });
    expect(sourceTimeAtOutputLocal(clip, 0)).toBeCloseTo(1);
    expect(sourceTimeAtOutputLocal(clip, 2)).toBeCloseTo(5); // 1 + 4
    expect(samplePlaybackRateAt(clip, 1)).toBeCloseTo(2);
  });

  it('computes output duration that consumes trimmed source', () => {
    // 10s source at constant 2× → 5s out
    expect(remappedClipDuration(makeClip({ playbackRate: 2 }))).toBeCloseTo(5);

    // Ramp 1→3 over enough output to burn 10s source
    const clip = makeClip({
      duration: 10,
      automation: {
        playbackRate: [
          { t: 0, value: 1 },
          { t: 4, value: 3 },
        ],
      },
    });
    const out = remappedClipDuration(clip);
    // At t=4, integral = ∫₀⁴ (1 + 0.5t) = [t + 0.25t²]_0^4 = 4+4 = 8
    // Remaining 2s source at rate 3 → +2/3 ≈ 0.667 → total ≈ 4.667
    expect(out).toBeCloseTo(4 + 2 / 3, 2);
    expect(clipHasRateAutomation(clip)).toBe(true);
  });

  it('falls back when automation is empty', () => {
    expect(clipHasRateAutomation(makeClip())).toBe(false);
    expect(remappedClipDuration(makeClip({ playbackRate: 0.5 }))).toBeCloseTo(20);
  });
});
