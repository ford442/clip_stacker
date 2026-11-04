import { describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { clipHasExtractableAudio } from './waveform';
import { requestTimelineWaveform } from './timelineMediaCache';

describe('clipHasExtractableAudio', () => {
  it('is true when audio is present or unknown', () => {
    expect(clipHasExtractableAudio({})).toBe(true);
    expect(clipHasExtractableAudio({ hasAudio: true })).toBe(true);
  });

  it('is false for silent media and stills', () => {
    expect(clipHasExtractableAudio({ hasAudio: false })).toBe(false);
    expect(clipHasExtractableAudio({ stillImage: true })).toBe(false);
  });
});

describe('requestTimelineWaveform', () => {
  it('does not decode (or call back for) a clip without audio', () => {
    const onComplete = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const silent = { id: 'silent', kind: 'video', hasAudio: false, objectUrl: 'blob:silent' } as Clip;

    requestTimelineWaveform(silent, onComplete, { allowVideo: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
