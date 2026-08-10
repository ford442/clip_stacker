import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  audioBufferToWav,
  clampAutomationValue,
  clipHasAudioAutomation,
  collectAutomationBreakpoints,
  defaultAutomationValue,
  normalizeClipAutomation,
  sampleAutomation,
  timelineHasAudioAutomation,
} from './clipAutomation';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File([], 'a.mp4'),
    objectUrl: 'blob:a',
    title: 'a',
    kind: 'video',
    duration: 4,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('clipAutomation', () => {
  it('defaults volume to clip.volume and pan to 0 when empty', () => {
    const clip = makeClip({ volume: 0.5 });
    expect(sampleAutomation(clip, 'volume', 1)).toBe(0.5);
    expect(sampleAutomation(clip, 'pan', 1)).toBe(0);
    expect(defaultAutomationValue(clip, 'volume')).toBe(0.5);
  });

  it('samples absolute volume keyframes over local time', () => {
    const clip = makeClip({
      volume: 1,
      automation: {
        volume: [
          { t: 0, value: 1 },
          { t: 1, value: 0.2 },
          { t: 2, value: 1.5 },
        ],
      },
    });
    expect(sampleAutomation(clip, 'volume', 0)).toBeCloseTo(1);
    expect(sampleAutomation(clip, 'volume', 0.5)).toBeCloseTo(0.6);
    expect(sampleAutomation(clip, 'volume', 1)).toBeCloseTo(0.2);
    expect(sampleAutomation(clip, 'volume', 2)).toBeCloseTo(1.5);
    expect(sampleAutomation(clip, 'volume', 3)).toBeCloseTo(1.5);
  });

  it('clamps volume / pan / playbackRate values', () => {
    expect(clampAutomationValue('volume', 3)).toBe(2);
    expect(clampAutomationValue('volume', -1)).toBe(0);
    expect(clampAutomationValue('pan', 2)).toBe(1);
    expect(clampAutomationValue('pan', -2)).toBe(-1);
    expect(clampAutomationValue('playbackRate', 0.1)).toBe(0.25);
  });

  it('detects audio automation presence', () => {
    expect(clipHasAudioAutomation(makeClip())).toBe(false);
    expect(
      clipHasAudioAutomation(
        makeClip({ automation: { volume: [{ t: 0, value: 1 }] } }),
      ),
    ).toBe(true);
    expect(
      clipHasAudioAutomation(
        makeClip({
          automation: {
            playbackRate: [
              { t: 0, value: 1 },
              { t: 1, value: 2 },
            ],
          },
        }),
      ),
    ).toBe(true);
    expect(
      timelineHasAudioAutomation([
        makeClip(),
        makeClip({ automation: { pan: [{ t: 0, value: -0.5 }] } }),
      ]),
    ).toBe(true);
  });

  it('normalizes automation tracks and drops empties', () => {
    expect(
      normalizeClipAutomation({
        volume: [{ t: 1, value: 9 }, { t: 0, value: 0.5 }],
        pan: [],
      }),
    ).toEqual({
      volume: [
        { t: 0, value: 0.5 },
        { t: 1, value: 2 },
      ],
    });
    expect(normalizeClipAutomation({ volume: [] })).toBeUndefined();
  });

  it('collects fade + keyframe breakpoints for AudioParam scheduling', () => {
    const points = collectAutomationBreakpoints({
      duration: 4,
      clipElapsed: 0,
      playDuration: 4,
      keyframes: [
        { t: 0, value: 1 },
        { t: 2, value: 0.2 },
      ],
      defaultValue: 1,
      fadeIn: 0.5,
      fadeOut: 0.5,
    });
    expect(points[0]?.localTime).toBe(0);
    expect(points[0]?.value).toBe(0);
    const mid = points.find((p) => Math.abs(p.localTime - 2) < 1e-6);
    expect(mid?.value).toBeCloseTo(0.2);
    expect(points[points.length - 1]?.localTime).toBe(4);
  });

  it('encodes a mono AudioBuffer as a valid WAV header', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const buffer = {
      numberOfChannels: 1,
      sampleRate: 48_000,
      length: samples.length,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;

    const wav = audioBufferToWav(buffer);
    const view = new DataView(wav);
    const ascii = (offset: number, len: number) =>
      String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(offset + i)));

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.byteLength).toBe(44 + samples.length * 2);
  });
});
