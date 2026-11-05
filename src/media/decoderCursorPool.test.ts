import { describe, expect, it, vi } from 'vitest';
import {
  BACKWARD_JUMP_EPSILON_SEC,
  DecoderCursorPool,
  type ForwardFrameCursor,
} from './decoderCursorPool';

interface FakeCursor extends ForwardFrameCursor {
  close: (() => void) & { mock: { calls: unknown[] } };
}

function fakeFrame(timestampUs: number): VideoFrame {
  return { timestamp: timestampUs, close: vi.fn() } as unknown as VideoFrame;
}

function makeCursor(frames: (t: number) => VideoFrame | null = (t) => fakeFrame(t * 1e6)): FakeCursor {
  return {
    frameAt: vi.fn(async (t: number) => frames(t)) as ForwardFrameCursor['frameAt'],
    close: vi.fn() as unknown as FakeCursor['close'],
  };
}

describe('DecoderCursorPool', () => {
  it('reuses one cursor while requests move forward', async () => {
    const cursor = makeCursor();
    const open = vi.fn(async () => cursor);
    const pool = new DecoderCursorPool(open);

    await pool.frameAt('a', 0);
    await pool.frameAt('a', 0.5);
    await pool.frameAt('a', 1);

    expect(open).toHaveBeenCalledTimes(1);
    expect(pool.activeCount).toBe(1);
  });

  it('tolerates sub-frame backward jitter without reopening', async () => {
    const open = vi.fn(async () => makeCursor());
    const pool = new DecoderCursorPool(open);

    await pool.frameAt('a', 1);
    await pool.frameAt('a', 1 - BACKWARD_JUMP_EPSILON_SEC / 2);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reopens on a real backward scrub and closes the stale cursor', async () => {
    const first = makeCursor();
    const second = makeCursor();
    const cursors = [first, second];
    const open = vi.fn(async () => cursors.shift()!);
    const pool = new DecoderCursorPool(open);

    await pool.frameAt('a', 5);
    await pool.frameAt('a', 1);

    expect(open).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
    expect(pool.activeCount).toBe(1);
  });

  it('frees an exhausted cursor so the next request opens fresh', async () => {
    const exhausted = makeCursor(() => null);
    const fresh = makeCursor();
    const cursors = [exhausted, fresh];
    const open = vi.fn(async () => cursors.shift()!);
    const pool = new DecoderCursorPool(open);

    expect(await pool.frameAt('a', 0)).toBeNull();
    expect(exhausted.close).toHaveBeenCalled();
    expect(pool.activeCount).toBe(0);

    expect(await pool.frameAt('a', 1)).not.toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('marks a key unsupported when the cursor cannot open, and stops retrying', async () => {
    const open = vi.fn(async () => {
      throw new Error('no demuxer');
    });
    const pool = new DecoderCursorPool(open);

    expect(await pool.frameAt('webm', 0)).toBeNull();
    expect(pool.isUnsupported('webm')).toBe(true);
    expect(await pool.frameAt('webm', 1)).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('caps live cursors and evicts the eldest', async () => {
    const opened: FakeCursor[] = [];
    const open = vi.fn(async () => {
      const cursor = makeCursor();
      opened.push(cursor);
      return cursor;
    });
    const pool = new DecoderCursorPool(open, 2);

    await pool.frameAt('a', 0);
    await pool.frameAt('b', 0);
    await pool.frameAt('c', 0);

    expect(pool.activeCount).toBe(2);
    expect(opened[0]!.close).toHaveBeenCalled();
  });

  it('prunes keys that no longer belong to the timeline', async () => {
    const opened: FakeCursor[] = [];
    const open = vi.fn(async () => {
      const cursor = makeCursor();
      opened.push(cursor);
      return cursor;
    });
    const pool = new DecoderCursorPool(open);

    await pool.frameAt('keep', 0);
    await pool.frameAt('drop', 0);
    pool.pruneKeys((key) => key === 'keep');

    expect(pool.activeCount).toBe(1);
    expect(opened[1]!.close).toHaveBeenCalled();
  });
});
