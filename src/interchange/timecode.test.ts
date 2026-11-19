import { describe, expect, it } from 'vitest';
import {
  framesToTimecode,
  normalizeTimecode,
  timecodeRate,
  timecodeRateForFps,
  timecodeStartFrames,
  timecodeStartSeconds,
  timecodeToFrames,
} from './timecode';
import {
  fcpTimeToFrames,
  formatRationalSeconds,
  frameDurationText,
  parseRationalSeconds,
  rescaleFrames,
  secondsToFrames,
} from './rational';

describe('timecode', () => {
  it('counts non-drop timecode', () => {
    const rate = timecodeRate('30');
    expect(framesToTimecode(0, rate)).toBe('00:00:00:00');
    expect(framesToTimecode(108_000, rate)).toBe('01:00:00:00');
    expect(timecodeToFrames('01:00:00:00', rate)).toBe(108_000);
    expect(timecodeToFrames('00:00:01:29', rate)).toBe(59);
    expect(timecodeToFrames('00:00:01:30', rate)).toBeNull();
  });

  it('counts 29.97 drop frame (frames 0 and 1 skipped each minute but every tenth)', () => {
    const rate = timecodeRate('29.97df');
    expect(framesToTimecode(1800, rate)).toBe('00:01:00;02');
    expect(framesToTimecode(1799, rate)).toBe('00:00:59;29');
    expect(framesToTimecode(17_982, rate)).toBe('00:10:00;00');
    expect(framesToTimecode(107_892, rate)).toBe('01:00:00;00');
    for (const frames of [0, 1799, 1800, 17_981, 17_982, 107_892, 123_456]) {
      expect(timecodeToFrames(framesToTimecode(frames, rate), rate)).toBe(frames);
    }
  });

  it('round-trips 59.94 drop frame', () => {
    const rate = timecodeRate('59.94df');
    for (const frames of [0, 3599, 3600, 35_964, 215_784]) {
      expect(timecodeToFrames(framesToTimecode(frames, rate), rate)).toBe(frames);
    }
    expect(framesToTimecode(3600, rate)).toBe('00:01:00;04');
  });

  it('defaults the project start to 01:00:00:00 and rejects malformed text', () => {
    const rate = timecodeRate(undefined);
    expect(rate.id).toBe('30');
    expect(timecodeStartFrames(undefined, rate)).toBe(108_000);
    expect(timecodeStartFrames('garbage', rate)).toBe(108_000);
    expect(timecodeStartSeconds('01:00:00:00', '25')).toBe(3600);
    expect(timecodeStartSeconds('00:00:10:00', '29.97')).toBeCloseTo(10.01, 6);
    expect(normalizeTimecode('1:02:03:04', rate)).toBe('01:02:03:04');
    expect(normalizeTimecode('1:2:3:4', rate)).toBeNull();
    expect(normalizeTimecode('01:61:00:00', rate)).toBeNull();
  });

  it('finds the rate for an fps value', () => {
    expect(timecodeRateForFps(30000 / 1001)?.id).toBe('29.97');
    expect(timecodeRateForFps(30000 / 1001, true)?.id).toBe('29.97df');
    expect(timecodeRateForFps(25, true)?.id).toBe('25');
    expect(timecodeRateForFps(12)).toBeNull();
  });
});

describe('rational time', () => {
  it('writes and reads FCPXML rational seconds exactly', () => {
    const ntsc = timecodeRate('29.97');
    expect(formatRationalSeconds(0, ntsc)).toBe('0s');
    expect(formatRationalSeconds(1, ntsc)).toBe('1001/30000s');
    expect(formatRationalSeconds(30, timecodeRate('30'))).toBe('1s');
    expect(formatRationalSeconds(45, timecodeRate('30'))).toBe('3/2s');
    expect(frameDurationText(timecodeRate('24'))).toBe('1/24s');
    expect(parseRationalSeconds('1001/30000s')).toEqual([1001, 30000]);
    expect(parseRationalSeconds('12s')).toEqual([12, 1]);
    expect(parseRationalSeconds('1.5s')).toBeNull();
    for (const frames of [0, 1, 29, 107_892, 1_000_003]) {
      expect(fcpTimeToFrames(formatRationalSeconds(frames, ntsc), ntsc)).toBe(frames);
    }
  });

  it('rescales frames between rates and rounds seconds to the nearest frame', () => {
    expect(rescaleFrames(48, 24, timecodeRate('30'))).toBe(60);
    expect(secondsToFrames(1 / 60, timecodeRate('30'))).toBe(1);
    expect(secondsToFrames(Number.NaN, timecodeRate('30'))).toBe(0);
  });
});
