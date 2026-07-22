import { describe, it, expect } from 'vitest';
import {
  AsyncFrameQueue,
  computeBaseCts,
  isFrameInTrimWindow,
  selectDecodeWindow,
  type SampleTiming,
} from './webcodecs-decoder';

/** 30fps track at timescale 30000 (1001-tick samples ≈ 29.97fps simplified to 1000). */
function makeSamples(count: number, gopSize = 10, timescale = 30000, tickDuration = 1000): SampleTiming[] {
  return Array.from({ length: count }, (_, i) => ({
    cts: i * tickDuration,
    timescale,
    is_sync: i % gopSize === 0,
  }));
}

describe('selectDecodeWindow', () => {
  it('returns the full track for an untrimmed clip', () => {
    const samples = makeSamples(90); // 3s @ 30fps
    const window = selectDecodeWindow(samples, 0, 3);
    expect(window).toEqual({ startIndex: 0, endIndex: 89 });
  });

  it('starts at the last sync sample at or before trimStart', () => {
    const samples = makeSamples(90, 10); // sync at 0, 10, 20, ... (≈0.33s GOP)
    // trimStart 1.05s = sample 31.5 → last sync ≤ that is sample 30
    const window = selectDecodeWindow(samples, 1.05, 3);
    expect(window!.startIndex).toBe(30);
    expect(window!.endIndex).toBe(89);
  });

  it('ends at the last sample presenting before trimEnd', () => {
    const samples = makeSamples(90, 10);
    // trimEnd 1.5s → last sample with cts < 1.5s is sample 44 (cts 44/30 ≈ 1.4667)
    const window = selectDecodeWindow(samples, 0, 1.5);
    expect(window).toEqual({ startIndex: 0, endIndex: 44 });
  });

  it('normalizes tracks that do not start at cts 0 via baseCts', () => {
    const samples = makeSamples(90, 10).map((s) => ({ ...s, cts: s.cts + 60000 }));
    const base = computeBaseCts(samples);
    expect(base).toBe(60000);
    const window = selectDecodeWindow(samples, 1.05, 3, base);
    expect(window!.startIndex).toBe(30);
  });

  it('returns null for an empty track or empty trim window', () => {
    expect(selectDecodeWindow([], 0, 5)).toBeNull();
    const samples = makeSamples(90, 10);
    expect(selectDecodeWindow(samples, 0, 0)).toBeNull();
  });
});

describe('isFrameInTrimWindow', () => {
  it('accepts frames inside the window and tolerates timestamp jitter at the start', () => {
    expect(isFrameInTrimWindow(1.0, 1.0, 2.0)).toBe(true);
    expect(isFrameInTrimWindow(0.999, 1.0, 2.0)).toBe(true); // within half-frame epsilon
    expect(isFrameInTrimWindow(1.5, 1.0, 2.0)).toBe(true);
  });

  it('rejects frames before trimStart and at/after trimEnd', () => {
    expect(isFrameInTrimWindow(0.5, 1.0, 2.0)).toBe(false);
    expect(isFrameInTrimWindow(2.0, 1.0, 2.0)).toBe(false);
    expect(isFrameInTrimWindow(2.5, 1.0, 2.0)).toBe(false);
  });
});

describe('AsyncFrameQueue', () => {
  it('delivers pushed items in FIFO order', async () => {
    const queue = new AsyncFrameQueue<number>(4);
    queue.push(1);
    queue.push(2);
    expect(queue.size).toBe(2);
    expect(await queue.pull()).toBe(1);
    expect(await queue.pull()).toBe(2);
  });

  it('resolves a pending pull when an item arrives', async () => {
    const queue = new AsyncFrameQueue<string>(4);
    const pending = queue.pull();
    queue.push('frame');
    expect(await pending).toBe('frame');
  });

  it('reports capacity for ring-buffer backpressure', () => {
    const queue = new AsyncFrameQueue<number>(2);
    expect(queue.atCapacity).toBe(false);
    queue.push(1);
    queue.push(2);
    expect(queue.atCapacity).toBe(true);
  });

  it('returns null after close and drains remaining items first', async () => {
    const queue = new AsyncFrameQueue<number>(4);
    queue.push(7);
    queue.close();
    expect(await queue.pull()).toBe(7);
    expect(await queue.pull()).toBeNull();
  });

  it('rejects pulls after a failure', async () => {
    const queue = new AsyncFrameQueue<number>(4);
    queue.fail(new Error('decoder exploded'));
    await expect(queue.pull()).rejects.toThrow('decoder exploded');
  });

  it('releases blocked waiters on close', async () => {
    const queue = new AsyncFrameQueue<number>(4);
    const pending = queue.pull();
    queue.close();
    expect(await pending).toBeNull();
  });
});
