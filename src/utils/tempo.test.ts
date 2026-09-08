import { describe, expect, it } from 'vitest';
import {
  MAX_CLIP_PLAYBACK_RATE,
  MIN_CLIP_PLAYBACK_RATE,
  clampClipPlaybackRate,
} from './playbackRate';
import {
  clusterIoiBpm,
  confidenceLabel,
  getClipBpm,
  matchRate,
  phaseDeltaSec,
  snapToNearestBeat,
  tapTempo,
} from './tempo';

/** Evenly spaced onsets at `bpm`, starting at `offset`. */
function beatsAt(bpm: number, count: number, offset = 0): number[] {
  const period = 60 / bpm;
  return Array.from({ length: count }, (_, i) => offset + i * period);
}

describe('clusterIoiBpm', () => {
  it('recovers a clean 120 BPM grid with high confidence', () => {
    const { bpm, confidence, offsetSec } = clusterIoiBpm(beatsAt(120, 16, 0.5));
    expect(bpm).toBeCloseTo(120, 5);
    expect(confidence).toBeGreaterThan(0.6);
    expect(offsetSec).toBeCloseTo(0.5, 5);
  });

  it('keeps a 160 BPM pulse as-is (already inside the 70–180 window)', () => {
    // 80 BPM material detected on its eighth notes reads as ~160 BPM IOIs.
    // 160 is a legal tempo, so it is reported rather than folded to 80.
    const { bpm } = clusterIoiBpm(beatsAt(160, 16));
    expect(bpm).toBeCloseTo(160, 5);
  });

  it('folds an out-of-window 40 BPM pulse up one octave to 80', () => {
    const { bpm, confidence } = clusterIoiBpm(beatsAt(40, 12));
    expect(bpm).toBeCloseTo(80, 5);
    expect(confidence).toBeGreaterThan(0.6);
  });

  it('ignores stray onsets and still locks onto the dominant pulse', () => {
    const beats = beatsAt(120, 16);
    beats.splice(5, 1); // dropped onset → one doubled interval
    const { bpm, confidence } = clusterIoiBpm(beats);
    expect(bpm).toBeCloseTo(120, 5);
    expect(confidence).toBeGreaterThan(0.6);
  });

  it('returns no tempo for fewer than two onsets', () => {
    expect(clusterIoiBpm([]).bpm).toBeNull();
    expect(clusterIoiBpm([1.5]).bpm).toBeNull();
    expect(clusterIoiBpm([1.5]).confidence).toBe(0);
  });
});

describe('matchRate', () => {
  it('scales a 100 BPM clip up to a 120 BPM target', () => {
    expect(matchRate(100, 120)).toBeCloseTo(1.2, 3);
  });

  it('picks the octave nearest 1x for a wide tempo gap', () => {
    const rate = matchRate(70, 180);
    expect(rate).toBeGreaterThanOrEqual(MIN_CLIP_PLAYBACK_RATE);
    expect(rate).toBeLessThanOrEqual(MAX_CLIP_PLAYBACK_RATE);
    // 180/70 = 2.57x; the half-octave 1.29x is the watchable equivalent.
    expect(rate).toBeCloseTo(1.286, 3);
  });

  it('leaves octave-equivalent tempos alone', () => {
    expect(matchRate(60, 120)).toBeCloseTo(1, 5);
  });

  it('always returns a clamped playback rate', () => {
    for (const [follower, target] of [
      [1, 1000],
      [1000, 1],
      [90, 128],
      [174, 70],
    ] as const) {
      const rate = matchRate(follower, target);
      expect(rate).toBe(clampClipPlaybackRate(rate));
    }
  });

  it('falls back to 1x for unusable tempos', () => {
    expect(matchRate(0, 120)).toBe(1);
    expect(matchRate(120, Number.NaN)).toBe(1);
  });
});

describe('phaseDeltaSec', () => {
  it('is the signed timeline distance from follower to target', () => {
    expect(phaseDeltaSec(2, 3.5)).toBeCloseTo(1.5, 6);
    expect(phaseDeltaSec(3.5, 2)).toBeCloseTo(-1.5, 6);
  });
});

describe('snapToNearestBeat', () => {
  const beats = [0, 0.5, 1, 1.5, 2];

  it('snaps to the closest beat regardless of distance', () => {
    expect(snapToNearestBeat(0.6, beats)).toBe(0.5);
    expect(snapToNearestBeat(1.24, beats)).toBe(1);
    expect(snapToNearestBeat(9, beats)).toBe(2);
  });

  it('returns the input when there are no beats', () => {
    expect(snapToNearestBeat(1.23, [])).toBe(1.23);
  });
});

describe('tapTempo', () => {
  it('reads even taps as their BPM', () => {
    const taps = Array.from({ length: 6 }, (_, i) => 10 + i * 0.5);
    expect(tapTempo(taps)).toBeCloseTo(120, 5);
  });

  it('needs at least four taps', () => {
    expect(tapTempo([10, 10.5, 11])).toBeNull();
  });

  it('uses only the last eight taps', () => {
    // Early taps at 60 BPM, the last eight at 120 BPM.
    const slow = [0, 1, 2, 3, 4];
    const fast = Array.from({ length: 8 }, (_, i) => 4.5 + i * 0.5);
    expect(tapTempo([...slow, ...fast])).toBeCloseTo(120, 5);
  });
});

describe('getClipBpm', () => {
  it('prefers the override over the detected estimate', () => {
    expect(getClipBpm({ bpmEstimate: 128.4, bpmOverride: 130 })).toBe(130);
    expect(getClipBpm({ bpmEstimate: 128.4 })).toBe(128.4);
    expect(getClipBpm({})).toBeNull();
    expect(getClipBpm(null)).toBeNull();
    expect(getClipBpm({ bpmEstimate: 0 })).toBeNull();
  });
});

describe('confidenceLabel', () => {
  it('buckets 0-1 confidence', () => {
    expect(confidenceLabel(0.9)).toBe('High');
    expect(confidenceLabel(0.5)).toBe('Med');
    expect(confidenceLabel(0.1)).toBe('Low');
    expect(confidenceLabel(undefined)).toBe('Low');
  });
});
