import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  buildClipInputArgs,
  buildSingleClipFilter,
  clipHasSourceAudio,
  clipNeedsLoopInput,
  isNoAudioStreamError,
} from './core';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    file: new File([], overrides.title ?? 'clip.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:clip-1',
    title: 'clip.mp4',
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    inputName: 'input-0.png',
    ...overrides,
  };
}

describe('still image FFmpeg helpers', () => {
  it('detects still images and PNG files as having no source audio', () => {
    const still = makeClip({
      title: 'frame.png',
      stillImage: true,
      file: new File([], 'frame.png', { type: 'image/png' }),
    });
    expect(clipHasSourceAudio(still)).toBe(false);
    expect(clipNeedsLoopInput(still)).toBe(true);
    expect(buildClipInputArgs(still)).toEqual(['-loop', '1', '-i', 'input-0.png']);
  });

  it('buildSingleClipFilter synthesizes audio for still images', () => {
    const still = makeClip({
      title: 'frame.png',
      stillImage: true,
      file: new File([], 'frame.png', { type: 'image/png' }),
    });
    const filter = buildSingleClipFilter(still);
    expect(filter).toContain('[vout]');
    expect(filter).toContain('anullsrc=channel_layout=stereo');
    expect(filter).not.toContain('[0:a]');
  });

  it('isNoAudioStreamError matches FFmpeg log text when message is generic FS error', () => {
    const err = new Error('ErrnoError: FS error');
    (err as { lastFfmpegError?: string }).lastFfmpegError =
      "Stream specifier ':a' in filtergraph matches no streams.";
    expect(isNoAudioStreamError(err)).toBe(true);
  });
});
