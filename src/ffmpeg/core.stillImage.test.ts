import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  buildClipInputArgs,
  buildSingleClipFilter,
  buildStillImageFfmpegArgs,
  buildStillImageVideoFilter,
  clipHasSourceAudio,
  clipNeedsLoopInput,
  isNoAudioStreamError,
  isStillImageClip,
  resolveStillImageEncodeDimensions,
  STILL_IMAGE_OUTPUT_FPS,
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

  it('buildSingleClipFilter applies setpts and atempo for playbackRate', () => {
    const clip = makeClip({
      playbackRate: 2,
      trimStart: 1,
      trimEnd: 5,
    });
    const filter = buildSingleClipFilter(clip);
    expect(filter).toContain('setpts=(PTS-STARTPTS)/2');
    expect(filter).toContain('atempo=2');
    expect(filter).toContain('trim=start=1:end=5');
  });

  it('buildSingleClipFilter chains atempo for 0.25×', () => {
    const clip = makeClip({ playbackRate: 0.25 });
    const filter = buildSingleClipFilter(clip);
    expect(filter).toContain('setpts=(PTS-STARTPTS)/0.25');
    expect(filter).toContain('atempo=0.5,atempo=0.5');
  });

  it('buildStillImageFfmpegArgs produces NLE-friendly encode settings', () => {
    const args = buildStillImageFfmpegArgs({
      inputName: 'splash.png',
      outputName: 'splash.mp4',
      durationSec: 5,
      width: 1920,
      height: 1080,
    });
    expect(args).toContain('-loop');
    expect(args).toContain('-tune');
    expect(args).toContain('stillimage');
    expect(args).toContain('-movflags');
    expect(args).toContain('+faststart');
    expect(args).toContain('-vsync');
    expect(args).toContain('cfr');
    expect(args.join(' ')).toContain(`fps=${STILL_IMAGE_OUTPUT_FPS}`);
    expect(args.join(' ')).toContain('anullsrc=channel_layout=stereo:sample_rate=44100:d=5');
    expect(args).not.toContain('-shortest');
  });

  it('buildStillImageVideoFilter scales, pads, and sets CFR fps', () => {
    expect(buildStillImageVideoFilter(1920, 1080)).toBe(
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p',
    );
  });

  it('resolveStillImageEncodeDimensions rounds to even sizes', () => {
    expect(resolveStillImageEncodeDimensions({ videoWidth: 801, videoHeight: 601 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('isStillImageClip detects flag and file extension', () => {
    expect(
      isStillImageClip({
        stillImage: true,
        file: new File([], 'x.bin', { type: 'application/octet-stream' }),
      }),
    ).toBe(true);
    expect(
      isStillImageClip({
        file: new File([], 'photo.jpg', { type: 'image/jpeg' }),
      }),
    ).toBe(true);
    expect(
      isStillImageClip({
        file: new File([], 'clip.mp4', { type: 'video/mp4' }),
      }),
    ).toBe(false);
  });

  it('isStillImageClip returns false for materialized video even with stillImage flag', () => {
    expect(
      isStillImageClip({
        stillImage: true,
        file: new File([], 'rife_2x_photo.png', { type: 'video/mp4' }),
      }),
    ).toBe(false);
  });

  it('isNoAudioStreamError matches FFmpeg log text when message is generic FS error', () => {
    const err = new Error('ErrnoError: FS error');
    (err as { lastFfmpegError?: string }).lastFfmpegError =
      "Stream specifier ':a' in filtergraph matches no streams.";
    expect(isNoAudioStreamError(err)).toBe(true);
  });
});
