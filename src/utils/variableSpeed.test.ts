import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  buildVariableSpeedFilter,
  buildVariableSpeedSegments,
} from './variableSpeed';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File([], 'v.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:c1',
    title: 'v.mp4',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: 10,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('buildVariableSpeedSegments', () => {
  it('returns one segment for constant rate', () => {
    const segments = buildVariableSpeedSegments(makeClip({ playbackRate: 2 }), 8);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].rate).toBeCloseTo(2, 1);
  });

  it('splits at automation keyframes', () => {
    const clip = makeClip({
      automation: {
        playbackRate: [
          { t: 0, value: 1 },
          { t: 5, value: 2 },
        ],
      },
    });
    const segments = buildVariableSpeedSegments(clip, 4);
    expect(segments.length).toBeGreaterThan(1);
  });
});

describe('buildVariableSpeedFilter', () => {
  it('emits setpts for variable speed automation', () => {
    const clip = makeClip({
      automation: {
        playbackRate: [
          { t: 0, value: 1 },
          { t: 4, value: 2 },
        ],
      },
    });
    const result = buildVariableSpeedFilter(clip, { segmentCount: 8 });
    expect(result.videoFilter).toContain('setpts');
    expect(result.videoFilter).toContain('trim=start=');
    expect(result.audioFilter).toContain('atrim=start=');
    expect(result.segmentCount).toBeGreaterThan(0);
  });

  it('uses concat for multi-segment curves', () => {
    const clip = makeClip({
      automation: {
        playbackRate: [
          { t: 0, value: 0.5 },
          { t: 3, value: 2 },
          { t: 6, value: 1 },
        ],
      },
    });
    const result = buildVariableSpeedFilter(clip, { segmentCount: 12 });
    expect(result.segmentCount).toBeGreaterThan(1);
    expect(result.videoFilter).toContain('concat=n=');
  });
});
