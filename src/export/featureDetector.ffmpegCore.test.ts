import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFfmpegCoreVariant } from './featureDetector';

describe('resolveFfmpegCoreVariant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the single-threaded core by default, even when cross-origin isolated', () => {
    // core-mt 0.12.10 traps when libx264 threads (the lossless-copy `startsWith` crash).
    vi.stubGlobal('crossOriginIsolated', true);
    expect(resolveFfmpegCoreVariant('')).toBe('st');
  });

  it('opts into the multi-threaded core with ?ffmpeg_mt only on an isolated page', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    expect(resolveFfmpegCoreVariant('?ffmpeg_mt')).toBe('mt');
    vi.stubGlobal('crossOriginIsolated', false);
    expect(resolveFfmpegCoreVariant('?ffmpeg_mt')).toBe('st');
  });
});
