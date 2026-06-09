import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import {
  allVideoClipsMatchOutputResolution,
  clipMatchesOutputResolution,
  clipsHaveMixedVideoDimensions,
  clipsNeedResolutionNormalization,
  usesFixedOutputResolution,
} from './resolution';

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

describe('resolution helpers', () => {
  it('treats explicit WIDTHxHEIGHT values as fixed output resolution', () => {
    expect(usesFixedOutputResolution(DEFAULT_EXPORT_SETTINGS)).toBe(true);
    expect(
      usesFixedOutputResolution({
        ...DEFAULT_EXPORT_SETTINGS,
        resolutionPreset: undefined,
        outputResolution: '1920x1080',
      }),
    ).toBe(true);
    expect(
      usesFixedOutputResolution({
        ...DEFAULT_EXPORT_SETTINGS,
        resolutionPreset: 'original',
        outputResolution: '1280x720',
      }),
    ).toBe(false);
  });

  it('detects when clips already match the export resolution', () => {
    const settings = { ...DEFAULT_EXPORT_SETTINGS };
    const clip = makeClip({ videoWidth: 1280, videoHeight: 720 });
    expect(clipMatchesOutputResolution(clip, settings)).toBe(true);
    expect(allVideoClipsMatchOutputResolution([clip], settings)).toBe(true);
    expect(clipsNeedResolutionNormalization([clip], settings)).toBe(false);
  });

  it('detects mixed native clip dimensions', () => {
    const clips = [
      makeClip({ videoWidth: 1920, videoHeight: 1080 }),
      makeClip({ id: 'clip-2', videoWidth: 1280, videoHeight: 720 }),
    ];
    expect(clipsHaveMixedVideoDimensions(clips)).toBe(true);
    expect(
      clipsHaveMixedVideoDimensions([
        makeClip({ videoWidth: 1280, videoHeight: 720 }),
        makeClip({ id: 'clip-2', videoWidth: 1280, videoHeight: 720 }),
      ]),
    ).toBe(false);
  });
});
