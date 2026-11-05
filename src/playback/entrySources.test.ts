import { describe, expect, it } from 'vitest';
import type { AudioScheduleEntry } from '../audio/schedule';
import { entryBufferRate, planEntryCycles } from './entrySources';

function entry(over: Partial<AudioScheduleEntry>): AudioScheduleEntry {
  return {
    clipId: 'c',
    timelineStart: 2,
    duration: 3,
    cycleDuration: 3,
    loopCount: 1,
    bufferOffset: 0,
    playbackRate: 1,
    ...over,
  } as AudioScheduleEntry;
}

describe('planEntryCycles', () => {
  it('schedules a future entry at its offset from now', () => {
    const [cycle, ...rest] = planEntryCycles(entry({}), 3, 0, 10);
    expect(rest).toHaveLength(0);
    expect(cycle).toMatchObject({ when: 12, bufferOffset: 0, globalClipElapsed: 0, rate: 1 });
    expect(cycle!.playDuration).toBeCloseTo(3 - 1e-4, 6);
  });

  it('starts mid-entry from the elapsed offset', () => {
    const [cycle] = planEntryCycles(entry({}), 3, 3, 10);
    expect(cycle).toMatchObject({ when: 10, globalClipElapsed: 1 });
    expect(cycle!.bufferOffset).toBeCloseTo(1, 9);
  });

  it('plays one source per remaining loop cycle, sampling automation globally', () => {
    const cycles = planEntryCycles(entry({ loopCount: 3, cycleDuration: 1, duration: 3 }), 1.0001, 3.5, 0);
    expect(cycles.map((c) => c.when)).toEqual([0, 0.5]);
    expect(cycles[0]!.bufferOffset).toBeCloseTo(0.5, 9);
    expect(cycles[1]!.bufferOffset).toBe(0);
    expect(cycles.every((c) => c.globalClipElapsed === 1.5)).toBe(true);
  });

  it('scales the buffer read by the playback rate and never reads past the buffer', () => {
    const [cycle] = planEntryCycles(entry({ playbackRate: 2 }), 2, 2, 0);
    expect(cycle!.rate).toBe(2);
    expect(cycle!.playDurationSource).toBeCloseTo(cycle!.playDuration * 2, 9);
    expect(cycle!.bufferOffset + cycle!.playDurationSource).toBeLessThanOrEqual(2);
  });

  it('uses rate 1 for a remapped buffer and skips finished entries', () => {
    expect(entryBufferRate(entry({ playbackRate: 2, rateRemap: true } as Partial<AudioScheduleEntry>))).toBe(1);
    expect(planEntryCycles(entry({}), 3, 6, 0)).toEqual([]);
  });
});
