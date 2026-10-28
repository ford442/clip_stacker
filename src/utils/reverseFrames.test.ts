import { describe, expect, it, vi } from 'vitest';
import type { SequentialFrame } from './decoderCursor';
import { ReverseChunkCache, type ReverseCursor } from './reverseFrames';

function fakeFrame(timestampUs: number): SequentialFrame {
  return {
    timestamp: timestampUs,
    duration: 1_000_000 / 30,
    close: vi.fn(),
    clone() {
      return fakeFrame(timestampUs);
    },
  };
}

describe('ReverseChunkCache', () => {
  it('decodes the last second once, then serves earlier times in that chunk from memory', async () => {
    const opens: Array<{ start: number; end: number }> = [];
    const cache = new ReverseChunkCache(async (_key, start, end) => {
      opens.push({ start, end });
      const cursor: ReverseCursor = {
        frameAt: async (t) => fakeFrame(Math.floor(t * 30) * (1_000_000 / 30)),
        close: vi.fn(),
      };
      return cursor;
    });

    const first = await cache.frameAt('a', 9.9, 0, 10);
    const second = await cache.frameAt('a', 9.4, 0, 10);
    expect(opens).toEqual([{ start: 9, end: 10 }]);
    expect(first?.timestamp).toBeGreaterThan(9e6);
    expect(second?.timestamp).toBeLessThan(first!.timestamp);
    first?.close();
    second?.close();
    cache.destroy();
  });

  it('opens the previous chunk when playback walks out of the cached second', async () => {
    const opens: number[] = [];
    const cache = new ReverseChunkCache(async (_key, start) => {
      opens.push(start);
      return {
        frameAt: async (t) => fakeFrame(Math.round(t * 1_000_000)),
        close: () => undefined,
      };
    });

    await cache.frameAt('a', 9.5, 0, 10);
    await cache.frameAt('a', 8.5, 0, 10);
    expect(opens).toEqual([9, 8]);
    cache.destroy();
  });
});
