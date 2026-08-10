import { describe, expect, it } from 'vitest';
import {
  audioTempoFilterSegment,
  buildAtempoChain,
  clampClipPlaybackRate,
  clipHasPlaybackRateAdjustment,
  clipSourceTimeAtLocal,
  formatPlaybackRate,
  getClipPlaybackRate,
  videoSetptsFilter,
} from './playbackRate';

describe('playbackRate', () => {
  it('clamps to 0.25–4 and defaults missing values to 1', () => {
    expect(clampClipPlaybackRate(undefined)).toBe(1);
    expect(clampClipPlaybackRate(0)).toBe(1);
    expect(clampClipPlaybackRate(0.1)).toBe(0.25);
    expect(clampClipPlaybackRate(8)).toBe(4);
    expect(getClipPlaybackRate({ playbackRate: 2 })).toBe(2);
  });

  it('detects non-default rates', () => {
    expect(clipHasPlaybackRateAdjustment({})).toBe(false);
    expect(clipHasPlaybackRateAdjustment({ playbackRate: 1 })).toBe(false);
    expect(clipHasPlaybackRateAdjustment({ playbackRate: 2 })).toBe(true);
  });

  it('builds setpts for normal and non-1 rates', () => {
    expect(videoSetptsFilter(1)).toBe('setpts=PTS-STARTPTS');
    expect(videoSetptsFilter(2)).toBe('setpts=(PTS-STARTPTS)/2');
    expect(videoSetptsFilter(0.5)).toBe('setpts=(PTS-STARTPTS)/0.5');
  });

  it('chains atempo for rates below 0.5', () => {
    expect(buildAtempoChain(1)).toBe('');
    expect(buildAtempoChain(2)).toBe('atempo=2');
    expect(buildAtempoChain(0.5)).toBe('atempo=0.5');
    expect(buildAtempoChain(0.25)).toBe('atempo=0.5,atempo=0.5');
    expect(audioTempoFilterSegment(0.25)).toBe(',atempo=0.5,atempo=0.5');
    expect(audioTempoFilterSegment(1)).toBe('');
  });

  it('maps local output time to source time', () => {
    expect(
      clipSourceTimeAtLocal({ trimStart: 2, playbackRate: 2 }, 1.5),
    ).toBeCloseTo(5);
    expect(
      clipSourceTimeAtLocal({ trimStart: 1, playbackRate: 0.5 }, 2),
    ).toBeCloseTo(2);
  });

  it('formats rates without trailing zeros', () => {
    expect(formatPlaybackRate(2)).toBe('2');
    expect(formatPlaybackRate(0.5)).toBe('0.5');
  });
});
