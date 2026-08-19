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

  it('stream-copy concat args mux silent AAC instead of dropping audio', () => {
    const args = buildIntercutConcatArgs('list.txt', 'out.mp4', true, 'silent');
    expect(args).not.toContain('-an');
    expect(args).toContain('silent_unit.m4a');
    expect(args).toContain('-stream_loop');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    expect(args).toContain('+faststart');
    expect(args).toContain('+genpts');
  });

  it('re-encode concat args keep AAC and force CFR without B-frames', () => {
    const both = buildIntercutConcatArgs('list.txt', 'out.mp4', false, 'both');
    expect(both).toContain('libx264');
    expect(both).toContain('aac');
    expect(both).toContain('+genpts');
    expect(both[both.indexOf('-r') + 1]).toBe('30');
    expect(both[both.indexOf('-vsync') + 1]).toBe('cfr');
    expect(both[both.indexOf('-bf') + 1]).toBe('0');

    const silent = buildIntercutConcatArgs('list.txt', 'out.mp4', false, 'silent');
    expect(silent).not.toContain('-an');
    expect(silent).toContain('silent_unit.m4a');
    expect(silent[silent.indexOf('-c:a') + 1]).toBe('copy');
    expect(silent[silent.indexOf('-r') + 1]).toBe('30');
    expect(silent[silent.indexOf('-bf') + 1]).toBe('0');
  });

  it('normalize args scale/pad and force 30fps', () => {
    const clip = makeClip();
    const args = buildNormalizeIntercutArgs(clip, 'in.mp4', 'norm.mp4', 1280, 720);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('scale=1280:720');
    expect(filter).toContain('fps=30');
    expect(filter).toContain('[0:a]aresample=44100');
  });

  it('normalize args can seek/trim to a source window', () => {
    const clip = makeClip();
    const args = buildNormalizeIntercutArgs(clip, 'in.mp4', 'norm.mp4', 1280, 720, {
      seekSec: 1.5,
      durationSec: 4,
    });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('1.5');
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('4');
  });

  it('normalize args synthesize silent audio for video-only clips', () => {
    const clip = makeClip({ hasAudio: false });
    const args = buildNormalizeIntercutArgs(clip, 'intercut-a.mp4', 'norm.mp4', 1280, 720);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[0:v]');
    expect(filter).not.toContain('[0:a]');
    expect(args).toContain('-stream_loop');
    expect(args).toContain('silent_unit.m4a');
    expect(args).toContain('-shortest');
    expect(args).toContain('1:a');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
    expect(args).not.toContain('anullsrc=r=44100:cl=stereo');
  });

  it('normalize args can force silent audio even when clip metadata is unknown', () => {
    const clip = makeClip();
    const args = buildNormalizeIntercutArgs(clip, 'in.mp4', 'norm.mp4', 1280, 720, {
      hasAudio: false,
    });
    expect(args.join(' ')).not.toContain('[0:a]');
    expect(args).toContain('-stream_loop');
    expect(args).toContain('silent_unit.m4a');
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
  });

  it('detects audio-stream mismatch as needing normalization', () => {
    const withAudio = makeClip();
    const silent = makeClip({
      id: 'clip-b',
      hasAudio: false,
      file: new File([], 'b.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(withAudio, silent)).toBe(true);
    expect(intercutNeedsNormalization(withAudio, makeClip({ id: 'clip-b2' }))).toBe(false);
  });

  it('detects a third-clip mismatch as needing normalization', () => {
    const a = makeClip();
    const b = makeClip({ id: 'clip-b', file: new File([], 'b.mp4', { type: 'video/mp4' }) });
    const c = makeClip({
      id: 'clip-c',
      videoWidth: 1920,
      videoHeight: 1080,
      file: new File([], 'c.mp4', { type: 'video/mp4' }),
    });
    expect(intercutNeedsNormalization(a, b, c)).toBe(true);
    expect(intercutNeedsNormalization(a, b, makeClip({ id: 'clip-c2' }))).toBe(false);
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

  it('estimate flags shortage and always reports re-encode', () => {
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
    // Generation always re-encodes (stream-copy is unsafe for alternating inpoints).
    expect(long.usedStreamCopy).toBe(false);
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

  it('estimate includes tail duration and honors forced landing clip', () => {
    const withTail = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      automation: {
        totalDurationSec: 0.4,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      forceFinalClip: 'B',
      tailDurationSec: 2,
    });
    expect(withTail.shortageMessage).toBeNull();
    expect(withTail.outputDurationSec).toBeCloseTo(2.4, 5);
    expect(withTail.slices[withTail.slices.length - 1]!.slot).toBe('B');
  });

  it('estimate plans A/B/C slices when clip C is set', () => {
    const triple = estimateIntercut({
      clipA: makeClip({ duration: 30, trimEnd: 30 }),
      clipB: makeClip({ id: 'b', duration: 30, trimEnd: 30, file: new File([], 'b.mp4') }),
      clipC: makeClip({ id: 'c', duration: 30, trimEnd: 30, file: new File([], 'c.mp4') }),
      automation: {
        totalDurationSec: 0.6,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });
    expect(triple.shortageMessage).toBeNull();
    expect(triple.slices.map((s) => s.slot)).toEqual(['A', 'B', 'C']);
  });
});
