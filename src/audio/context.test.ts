import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioContext, PREVIEW_SAMPLE_RATE } from './context';

describe('createAudioContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to interactive latency and the 48kHz preview sample rate', () => {
    const ctor = vi.fn(function FakeAudioContext(this: unknown, options?: unknown) {
      return { options };
    }) as unknown as typeof AudioContext;
    vi.stubGlobal('window', { AudioContext: ctor });

    createAudioContext();

    expect(ctor).toHaveBeenCalledWith({ latencyHint: 'interactive', sampleRate: PREVIEW_SAMPLE_RATE });
  });

  it('honors explicit overrides', () => {
    const ctor = vi.fn(function FakeAudioContext(this: unknown, options?: unknown) {
      return { options };
    }) as unknown as typeof AudioContext;
    vi.stubGlobal('window', { AudioContext: ctor });

    createAudioContext({ latencyHint: 'playback', sampleRate: 44_100 });

    expect(ctor).toHaveBeenCalledWith({ latencyHint: 'playback', sampleRate: 44_100 });
  });

  it('falls back to the webkitAudioContext constructor when AudioContext is absent', () => {
    const ctor = vi.fn(function FakeWebkitAudioContext(this: unknown, options?: unknown) {
      return { options };
    }) as unknown as typeof AudioContext;
    vi.stubGlobal('window', { webkitAudioContext: ctor });

    createAudioContext();

    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it('retries without an explicit sampleRate if the platform rejects it', () => {
    let calls = 0;
    const ctor = vi.fn(function FakeAudioContext(this: { options: unknown }, options?: unknown) {
      calls += 1;
      if (calls === 1) throw new DOMException('unsupported sample rate', 'NotSupportedError');
      this.options = options;
    }) as unknown as typeof AudioContext;
    vi.stubGlobal('window', { AudioContext: ctor });

    const result = createAudioContext();

    expect(ctor).toHaveBeenCalledTimes(2);
    expect(ctor).toHaveBeenLastCalledWith({ latencyHint: 'interactive' });
    expect((result as unknown as { options: unknown }).options).toEqual({ latencyHint: 'interactive' });
  });

  it('throws when no AudioContext constructor exists', () => {
    vi.stubGlobal('window', {});
    expect(() => createAudioContext()).toThrow(/AudioContext is not available/);
  });
});
