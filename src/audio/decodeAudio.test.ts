import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetDecodeAudioForTests, decodeAudio, DECODE_SAMPLE_RATE } from './decodeAudio';

class FakeOffline {
  static made: { rate: number; ctx: FakeOffline }[] = [];
  decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => ({ sampleRate: this.rate, length: bytes.byteLength }) as unknown as AudioBuffer);
  constructor(_channels: number, _length: number, public rate: number) {
    FakeOffline.made.push({ rate, ctx: this });
  }
}

describe('decodeAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetDecodeAudioForTests();
    FakeOffline.made = [];
  });

  it('decodes on an offline context at 48 kHz by default and reuses it', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOffline);
    const a = await decodeAudio(new Blob([new Uint8Array(4)]));
    const b = await decodeAudio(new Blob([new Uint8Array(6)]));
    expect(DECODE_SAMPLE_RATE).toBe(48_000);
    expect(a.sampleRate).toBe(48_000);
    expect(b.length).toBe(6);
    expect(FakeOffline.made.map((m) => m.rate)).toEqual([48_000]);
  });

  it('keeps one context per requested rate', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOffline);
    await decodeAudio(new ArrayBuffer(2), { sampleRate: 16_000 });
    await decodeAudio(new ArrayBuffer(2));
    await decodeAudio(new ArrayBuffer(2), { sampleRate: 16_000 });
    expect(FakeOffline.made.map((m) => m.rate)).toEqual([16_000, 48_000]);
  });

  it('never detaches an ArrayBuffer the caller passed in', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOffline);
    const bytes = new ArrayBuffer(8);
    await decodeAudio(bytes);
    const passed = FakeOffline.made[0].ctx.decodeAudioData.mock.calls[0][0];
    expect(passed).not.toBe(bytes);
    expect(passed.byteLength).toBe(8);
  });

  it('fetches URLs and honours an abort signal', async () => {
    vi.stubGlobal('OfflineAudioContext', FakeOffline);
    const fetchMock = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(3) }));
    vi.stubGlobal('fetch', fetchMock);
    const buffer = await decodeAudio('blob:x');
    expect(fetchMock).toHaveBeenCalledWith('blob:x', undefined);
    expect(buffer.length).toBe(3);

    const controller = new AbortController();
    controller.abort();
    await expect(decodeAudio('blob:x', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects when the browser has no OfflineAudioContext', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    await expect(decodeAudio(new ArrayBuffer(1))).rejects.toThrow(/OfflineAudioContext/);
  });
});
