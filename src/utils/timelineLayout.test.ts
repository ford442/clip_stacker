import { describe, it, expect } from 'vitest';
import {
  buildRulerTicks,
  clipPixelWidth,
  formatTimelineTime,
  rulerTickInterval,
  timelineContentWidth,
} from './timelineLayout';

describe('timelineLayout', () => {
  it('formats short and long durations', () => {
    expect(formatTimelineTime(5)).toBe('5.0s');
    expect(formatTimelineTime(75)).toBe('1:15');
  });

  it('uses proportional pixel widths', () => {
    expect(clipPixelWidth(2, 50)).toBe(100);
    expect(clipPixelWidth(10, 50)).toBe(500);
    expect(clipPixelWidth(0.1, 10)).toBe(48);
  });

  it('builds ruler ticks across the full duration', () => {
    expect(rulerTickInterval(30)).toBe(5);
    expect(buildRulerTicks(12, 5)).toEqual([0, 5, 10, 12]);
    expect(timelineContentWidth(10, 40)).toBe(400);
  });
});
