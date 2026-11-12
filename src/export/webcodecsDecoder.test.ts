import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  AsyncFrameQueue,
  DecodeWindowEnd,
  isFrameInTrimWindow,
  resolveDecoderConfig,
} from './webcodecsDecoder';

type Packet = { type: 'key' | 'delta'; timestamp: number };

/** Feed `packets` (decode order, µs) until the window end says stop; return what was fed. */
function fedUntilPast(trimEndSec: number, packets: Packet[]): number[] {
  const end = new DecodeWindowEnd(trimEndSec);
  const fed: number[] = [];
  for (const packet of packets) {
    if (end.isPast(packet)) break;
    fed.push(packet.timestamp);
  }
  return fed;
}

const ms = (t: number) => t * 1000;

describe('DecodeWindowEnd', () => {
  it('feeds everything when the window runs to the end of the track', () => {
    const packets: Packet[] = [0, 1, 2, 3].map((i) => ({ type: i % 2 ? 'delta' : 'key', timestamp: ms(i * 500) }));
    expect(fedUntilPast(Infinity, packets)).toEqual(packets.map((p) => p.timestamp));
  });

  it('stops after the first key packet at or past trimEnd (closed GOPs)', () => {
    // GOP of two frames, 0.5 s apart: keys at 0, 1, 2 s.
    const packets: Packet[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      type: i % 2 === 0 ? 'key' : 'delta',
      timestamp: ms(i * 500),
    }));
    // trimEnd 1.2 s: the key at 2 s is fed (open-GOP leading pictures could
    // reference it), the delta presenting after it is not.
    expect(fedUntilPast(1.2, packets)).toEqual([0, 500, 1000, 1500, 2000].map(ms));
  });

  it('keeps feeding open-GOP leading pictures that present before the boundary key', () => {
    // Decode order: I(0) P(0.1) | I(0.3) B(0.2) P(0.4) — the B presents before its key.
    const packets: Packet[] = [
      { type: 'key', timestamp: ms(0) },
      { type: 'delta', timestamp: ms(100) },
      { type: 'key', timestamp: ms(300) },
      { type: 'delta', timestamp: ms(200) },
      { type: 'delta', timestamp: ms(400) },
    ];
    expect(fedUntilPast(0.25, packets)).toEqual([0, 100, 300, 200].map(ms));
  });

  it('treats a key exactly at trimEnd as the boundary', () => {
    const packets: Packet[] = [
      { type: 'key', timestamp: ms(0) },
      { type: 'delta', timestamp: ms(500) },
      { type: 'key', timestamp: ms(1000) },
      { type: 'delta', timestamp: ms(1500) },
    ];
    expect(fedUntilPast(1, packets)).toEqual([0, 500, 1000].map(ms));
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

describe('resolveDecoderConfig', () => {
  const base: VideoDecoderConfig = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps hardware decode when the machine has it', async () => {
    vi.stubGlobal('VideoDecoder', { isConfigSupported: vi.fn(async () => ({ supported: true })) });
    expect((await resolveDecoderConfig(base))?.hardwareAcceleration).toBe('prefer-hardware');
  });

  it('falls back to no-preference, then prefer-software', async () => {
    const isConfigSupported = vi.fn(async (config: VideoDecoderConfig) => ({
      supported: config.hardwareAcceleration === 'prefer-software',
    }));
    vi.stubGlobal('VideoDecoder', { isConfigSupported });
    const resolved = await resolveDecoderConfig(base);
    expect(resolved).toEqual({ ...base, hardwareAcceleration: 'prefer-software' });
    expect(isConfigSupported.mock.calls.map(([c]) => c.hardwareAcceleration)).toEqual([
      'prefer-hardware',
      'no-preference',
      'prefer-software',
    ]);
  });

  it('returns null when no rung is supported', async () => {
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: vi.fn(async () => {
        throw new TypeError('unknown codec');
      }),
    });
    expect(await resolveDecoderConfig(base)).toBeNull();
  });

  it('walks a caller-supplied ladder in order', async () => {
    const isConfigSupported = vi.fn(async (config: VideoDecoderConfig) => ({
      supported: config.hardwareAcceleration === 'no-preference',
    }));
    vi.stubGlobal('VideoDecoder', { isConfigSupported });
    const resolved = await resolveDecoderConfig(base, ['prefer-software', 'no-preference']);
    expect(resolved?.hardwareAcceleration).toBe('no-preference');
    expect(isConfigSupported.mock.calls.map(([c]) => c.hardwareAcceleration)).toEqual([
      'prefer-software',
      'no-preference',
    ]);
  });
});
