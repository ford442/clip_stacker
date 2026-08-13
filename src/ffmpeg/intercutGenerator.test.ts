import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  buildIntercutConcatArgs,
  buildNormalizeIntercutArgs,
  buildReplaceAudioFromAArgs,
  estimateIntercut,
  intercutNeedsNormalization,
} from './intercutGenerator';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-a',
    file: new File([], 'a.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:a',
    title: 'a.mp4',
    kind: 'video',
    duration: 10,
    videoWidth: 1280,
    videoHeight: 720,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('intercutGenerator helpers', () => {
  it('detects resolution mismatch as needing normalization', () => {
    const a = makeClip();
    const b = makeClip({
      id: 'clip-b',
      videoWidth: 1920,
      videoHeight: 1080,
      file: new File([], 'b.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(a, b)).toBe(true);
    expect(intercutNeedsNormalization(a, makeClip({ id: 'clip-b2' }))).toBe(false);
  });

  it('detects fps and container mismatch', () => {
    const a = makeClip({ originalFps: 24 });
    const b = makeClip({
      id: 'b',
      originalFps: 30,
      file: new File([], 'b.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(a, b)).toBe(true);

    const webm = makeClip({
      id: 'w',
      file: new File([], 'b.webm', { type: 'video/webm' }),
    });
    expect(intercutNeedsNormalization(a, webm)).toBe(true);
  });

  it('stream-copy concat args omit audio when silent', () => {
    const args = buildIntercutConcatArgs('list.txt', 'out.mp4', true, 'silent');
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  it('re-encode concat args include aac unless silent', () => {
    const both = buildIntercutConcatArgs('list.txt', 'out.mp4', false, 'both');
    expect(both).toContain('libx264');
    expect(both).toContain('aac');

    const silent = buildIntercutConcatArgs('list.txt', 'out.mp4', false, 'silent');
    expect(silent).toContain('-an');
  });

  it('normalize args scale/pad and force 30fps', () => {
    const clip = makeClip();
    const args = buildNormalizeIntercutArgs(clip, 'in.mp4', 'norm.mp4', 1280, 720);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('scale=1280:720');
    expect(filter).toContain('fps=30');
  });

  it('replace-audio args map video from concat and audio from A', () => {
    const args = buildReplaceAudioFromAArgs(
      'concat.mp4',
      'a.mp4',
      makeClip({ trimStart: 1.5 }),
      4,
      'out.mp4',
    );
    expect(args).toContain('0:v:0');
    expect(args).toContain('1:a:0?');
    expect(args).toContain('1.5');
    expect(args).toContain('4');
  });

  it('estimate flags shortage and stream-copy vs re-encode', () => {
    const long = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 4,
        startFrequencyHz: 1,
        endFrequencyHz: 1,
      },
    });
    expect(long.shortageMessage).toBeNull();
    expect(long.usedStreamCopy).toBe(true);
    expect(long.sliceCount).toBeGreaterThan(0);

    const strobe = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 2,
        startFrequencyHz: 8,
        endFrequencyHz: 12,
      },
    });
    expect(strobe.usedStreamCopy).toBe(false);

    const short = estimateIntercut({
      clipA: makeClip({ duration: 0.2, trimEnd: 0.2 }),
      clipB: makeClip({ id: 'b', duration: 10, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 5,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });
    expect(short.shortageMessage).toMatch(/only cover/i);
  });
});
