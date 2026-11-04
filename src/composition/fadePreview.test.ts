import { describe, expect, it } from 'vitest';
import {
  computeFadeAlpha,
  computeFadePreviewAlpha,
  getFadePreviewTiming,
} from './fadePreview';

describe('fadePreview', () => {
  it('seeks fade-in preview to trimStart + fadeDuration/2', () => {
    const timing = getFadePreviewTiming('in', 2, 12, 20, 4);
    expect(timing.seekTime).toBe(4);
    expect(timing.elapsed).toBe(2);
    expect(timing.previewDuration).toBe(10);
  });

  it('seeks fade-out preview to trimEnd - fadeDuration/2', () => {
    const timing = getFadePreviewTiming('out', 0, 10, 20, 4);
    expect(timing.seekTime).toBe(8);
    expect(timing.elapsed).toBe(8);
  });

  it('uses trim boundaries when fade duration is zero', () => {
    expect(getFadePreviewTiming('in', 1.5, 10, 20, 0).seekTime).toBe(1.5);
    expect(getFadePreviewTiming('out', 0, 10, 20, 0).seekTime).toBe(10);
  });

  it('computes midpoint opacity for active fades', () => {
    const timing = getFadePreviewTiming('in', 0, 10, 10, 2);
    expect(computeFadePreviewAlpha('in', timing, 2)).toBeCloseTo(0.5);

    const outTiming = getFadePreviewTiming('out', 0, 10, 10, 2);
    expect(computeFadePreviewAlpha('out', outTiming, 2)).toBeCloseTo(0.5);
  });

  it('matches render-path fade alpha curve', () => {
    expect(computeFadeAlpha(0.5, 10, 2, 0)).toBeCloseTo(0.25);
    expect(computeFadeAlpha(9, 10, 0, 2)).toBeCloseTo(0.5);
  });
});
