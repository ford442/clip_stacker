import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { remapWaveformPeaks } from './automation';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File([], 'a.mp3', { type: 'audio/mpeg' }),
    objectUrl: 'blob:c1',
    title: 'a.mp3',
    kind: 'audio',
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

describe('remapWaveformPeaks', () => {
  it('returns uniform peaks when no automation is present', () => {
    const source = new Float32Array([0, 1, 0.5, 0.25]);
    const clip = makeClip({ playbackRate: 2 });
    const out = remapWaveformPeaks(source, clip, 4);
    expect(out.length).toBe(4);
    expect(out[1]).toBeGreaterThan(0);
  });

  it('changes bucket distribution when automation is present', () => {
    const source = new Float32Array(100);
    for (let i = 0; i < 50; i++) source[i] = 1;
    const clip = makeClip({
      automation: {
        playbackRate: [
          { t: 0, value: 1 },
          { t: 5, value: 2 },
        ],
      },
    });
    const uniform = remapWaveformPeaks(source, makeClip(), 20);
    const remapped = remapWaveformPeaks(source, clip, 20);
    expect(remapped).not.toEqual(uniform);
  });
});
