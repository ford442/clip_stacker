import { describe, expect, it } from 'vitest';
import {
  audioTempoFilterSegment,
  beatsSpannedByDuration,
  buildAtempoChain,
  clampClipPlaybackRate,
  clipHasPlaybackRateAdjustment,
  clipSourceTimeAtLocal,
  formatPlaybackRate,
  getClipPlaybackRate,
  getTrimmedSourceDuration,
  nudgePlaybackRate,
  outputDurationForRate,
  playbackRateForTargetDuration,
  playbackRateToFitBeats,
  roundPlaybackRate,
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

  it('computes trimmed source duration and fit-to-target rate', () => {
    expect(
      getTrimmedSourceDuration({ trimStart: 1, trimEnd: 5, duration: 10 }),
    ).toBe(4);
    // 4s source into 2s output → 2×
    expect(playbackRateForTargetDuration(4, 2)).toBe(2);
    // 4s source into 8s output → 0.5×
    expect(playbackRateForTargetDuration(4, 8)).toBe(0.5);
    expect(outputDurationForRate(4, 2)).toBe(2);
  });

  it('nudges and rounds rates for lip-sync tuning', () => {
    expect(nudgePlaybackRate(1, 0.01)).toBeCloseTo(1.01);
    expect(nudgePlaybackRate(1, -0.05)).toBeCloseTo(0.95);
    expect(roundPlaybackRate(1.23456)).toBeCloseTo(1.235);
  });

  it('fits a clip to an exact beat phrase at a given BPM', () => {
    // 4s source, 120 BPM → 8 beats = 4s → rate 1
    expect(playbackRateToFitBeats(4, 120, 8)).toBe(1);
    // 4s source into 4 beats @ 120 BPM (2s) → rate 2
    expect(playbackRateToFitBeats(4, 120, 4)).toBe(2);
    expect(beatsSpannedByDuration(4, 120)).toBeCloseTo(8);
    expect(playbackRateToFitBeats(4, 0, 8)).toBeNull();
  });
});
