import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { calculateRenderPlan } from './ffmpegService';

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

describe('calculateRenderPlan', () => {
  it('forces re-encoding when a clip is RIFE-processed', () => {
    const clip = makeClip({ title: 'RIFE Clip', rifeProcessed: true });

    const plan = calculateRenderPlan([clip], [], [], DEFAULT_EXPORT_SETTINGS);

    expect(plan.path).toBe('effects-reencoding');
    expect(plan.willReencode).toBe(true);
    expect(plan.reason).toContain('RIFE-processed');
  });

  it('forces re-encoding when clips have mixed native resolutions', () => {
    const clips = [
      makeClip({ videoWidth: 1920, videoHeight: 1080 }),
      makeClip({ id: 'clip-2', title: 'Clip 2', videoWidth: 1280, videoHeight: 720 }),
    ];

    const plan = calculateRenderPlan(
      clips,
      [],
      [],
      { ...DEFAULT_EXPORT_SETTINGS, resolutionPreset: 'original', outputResolution: 'original' },
    );

    expect(plan.path).toBe('effects-reencoding');
    expect(plan.willReencode).toBe(true);
    expect(plan.reason).toContain('different native resolutions');
  });
});
