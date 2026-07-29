import { describe, it, expect } from 'vitest';
import {
  TIMELINE_EXPORT_FPS,
  computeTimelineExportFrameCount,
  globalTimeForTimelineFrame,
  shouldEmitTimelineStatusUpdate,
  shouldWaitForEncoderBackpressure,
  timelineFrameTimestampUs,
  timelineStatusThrottleFrames,
  MAX_ENCODE_QUEUE_DEPTH,
} from './webcodecs-timeline';

describe('webcodecs-timeline', () => {
  describe('computeTimelineExportFrameCount', () => {
    it('returns zero for non-positive duration', () => {
      expect(computeTimelineExportFrameCount(0)).toBe(0);
      expect(computeTimelineExportFrameCount(-1)).toBe(0);
    });

    it('rounds to the nearest whole frame count', () => {
      expect(computeTimelineExportFrameCount(5)).toBe(150);
      expect(computeTimelineExportFrameCount(1 / 30)).toBe(1);
      expect(computeTimelineExportFrameCount(1 / 60)).toBe(1);
      expect(computeTimelineExportFrameCount(1 / 120)).toBe(0);
    });

    it('is exact and reproducible for fractional-second durations', () => {
      const duration = 2.7;
      const frames = computeTimelineExportFrameCount(duration);
      expect(frames).toBe(81);
      expect(globalTimeForTimelineFrame(frames - 1)).toBeCloseTo((frames - 1) / TIMELINE_EXPORT_FPS);
    });
  });

  describe('globalTimeForTimelineFrame', () => {
    it('avoids float accumulation drift from repeated += 1/30', () => {
      const frames = computeTimelineExportFrameCount(10);
      let accumulated = 0;
      for (let i = 1; i < frames; i++) {
        accumulated += 1 / TIMELINE_EXPORT_FPS;
      }
      const indexDriven = globalTimeForTimelineFrame(frames - 1);
      expect(indexDriven).toBe((frames - 1) / TIMELINE_EXPORT_FPS);
      expect(indexDriven).not.toBe(accumulated);
    });
  });

  describe('timelineFrameTimestampUs', () => {
    it('stays aligned with frame index', () => {
      const frameDurationUs = Math.round(1_000_000 / TIMELINE_EXPORT_FPS);
      expect(timelineFrameTimestampUs(0)).toBe(0);
      expect(timelineFrameTimestampUs(60)).toBe(60 * frameDurationUs);
    });
  });

  describe('shouldWaitForEncoderBackpressure', () => {
    it('waits when the queue exceeds the limit', () => {
      expect(shouldWaitForEncoderBackpressure(0)).toBe(false);
      expect(shouldWaitForEncoderBackpressure(MAX_ENCODE_QUEUE_DEPTH)).toBe(false);
      expect(shouldWaitForEncoderBackpressure(MAX_ENCODE_QUEUE_DEPTH + 1)).toBe(true);
    });

    it('respects a custom max depth', () => {
      expect(shouldWaitForEncoderBackpressure(5, 4)).toBe(true);
      expect(shouldWaitForEncoderBackpressure(4, 4)).toBe(false);
    });
  });

  describe('shouldEmitTimelineStatusUpdate', () => {
    const throttle = timelineStatusThrottleFrames();

    it('always emits the first and last frame', () => {
      const total = 90;
      expect(shouldEmitTimelineStatusUpdate(0, -throttle, throttle, total)).toBe(true);
      expect(shouldEmitTimelineStatusUpdate(total - 1, 0, throttle, total)).toBe(true);
    });

    it('throttles intermediate frames', () => {
      const total = 300;
      let last = 0;
      let emissions = 0;
      for (let i = 0; i < total; i++) {
        if (shouldEmitTimelineStatusUpdate(i, last, throttle, total)) {
          emissions++;
          last = i;
        }
      }
      expect(emissions).toBeLessThan(total / 2);
      expect(emissions).toBeGreaterThan(3);
    });
  });

  describe('export loop savings (synthetic)', () => {
    it('documents frame-count and per-frame overhead reductions at 1080p30', () => {
      const durationSec = 60;
      const fps = TIMELINE_EXPORT_FPS;
      const totalFrames = computeTimelineExportFrameCount(durationSec, fps);
      const throttleFrames = timelineStatusThrottleFrames(fps);
      const pixelsPerFrame = 1920 * 1080;
      const bytesPerPixel = 4;

      // Legacy float loop: globalTime += 1/30 while globalTime < duration
      let legacyFrames = 0;
      for (let t = 0; t < durationSec; t += 1 / fps) legacyFrames++;

      const statusCallsLegacy = totalFrames;
      let statusCallsNew = 0;
      let last = -throttleFrames;
      for (let i = 0; i < totalFrames; i++) {
        if (shouldEmitTimelineStatusUpdate(i, last, throttleFrames, totalFrames)) {
          statusCallsNew++;
          last = i;
        }
      }

      const canvasCopiesAvoidedPerExport = totalFrames; // no text-overlay projects
      const copyBytesAvoided = canvasCopiesAvoidedPerExport * pixelsPerFrame * bytesPerPixel;

      expect(totalFrames).toBe(1800);
      expect(legacyFrames).toBe(1801); // float `+= 1/30` includes one extra frame at 60s
      expect(statusCallsNew).toBeLessThan(statusCallsLegacy / 5);
      expect(copyBytesAvoided).toBeGreaterThan(14_000_000_000); // ~14.9 GB memcpy avoided / 60s 1080p
    });
  });
});
