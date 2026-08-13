import { afterEach, describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  collectSpeedKeyframeSnapTimes,
  formatPlaybackRateAria,
  formatPlaybackRateLabel,
  getLastSeedRate,
  setLastSeedRate,
  snapOutputLocalToMarkers,
  SPEED_LANE_LAST_SEED_KEY,
} from './speedLane';

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

describe('speedLane', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(SPEED_LANE_LAST_SEED_KEY);
    } catch {
      /* ignore */
    }
  });

  it('formats rate labels and aria text', () => {
    expect(formatPlaybackRateLabel(1)).toBe('1.00×');
    expect(formatPlaybackRateLabel(0.65)).toBe('0.65×');
    expect(formatPlaybackRateAria(0.75)).toBe('0.75 times');
    expect(formatPlaybackRateAria(1)).toBe('1 times');
  });

  it('persists last seed rate in localStorage', () => {
    expect(getLastSeedRate()).toBe(1);
    setLastSeedRate(0.82);
    expect(getLastSeedRate()).toBe(0.82);
  });

  it('collects sync markers, beats, and master markers as snap targets', () => {
    const clip = makeClip({
      playbackRate: 2,
      beatTimestamps: [2, 4],
      syncMarkers: [{ id: 's1', time: 1.5, text: 'open' }],
    });
    const targets = collectSpeedKeyframeSnapTimes(clip, 5, [
      { id: 'm1', time: 7.25, text: 'downbeat' },
    ]);
    expect(targets).toContain(1.5);
    expect(targets).toContain(1);
    expect(targets).toContain(2);
    expect(targets).toContain(2.25);
  });

  it('snaps output-local time to the nearest marker within threshold', () => {
    const targets = [1, 2.5, 4];
    expect(snapOutputLocalToMarkers(2.42, targets, 0.1)).toBe(2.5);
    expect(snapOutputLocalToMarkers(3.2, targets, 0.1)).toBe(3.2);
  });
});
