import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { __resetSharedAudioContextForTests } from '../audio/context';
import { useMediaVolume } from './useMediaVolume';

function fakeAudioContext() {
  const gainParam = { value: 1, setTargetAtTime: vi.fn() };
  const gain = { gain: gainParam, connect: vi.fn(), disconnect: vi.fn() };
  const source = { connect: vi.fn() };
  const ctx = {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createGain: vi.fn(() => gain),
    createMediaElementSource: vi.fn(() => source),
  };
  return { ctx, gain, gainParam };
}

describe('useMediaVolume', () => {
  let root: Root | null = null;
  let media: HTMLAudioElement;
  let fake: ReturnType<typeof fakeAudioContext>;

  function Probe({ volume, mediaKey }: { volume: number; mediaKey: string }) {
    const ref = useRef<HTMLAudioElement | null>(media);
    useMediaVolume(ref, volume, mediaKey);
    return null;
  }

  function render(volume: number, mediaKey = 'clip-1') {
    act(() => {
      root!.render(<Probe volume={volume} mediaKey={mediaKey} />);
    });
  }

  beforeEach(() => {
    __resetSharedAudioContextForTests();
    fake = fakeAudioContext();
    const ctor = vi.fn(function FakeAudioContext() {
      return fake.ctx;
    });
    vi.stubGlobal('AudioContext', ctor);
    window.AudioContext = ctor as unknown as typeof AudioContext;
    media = document.createElement('audio');
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    __resetSharedAudioContextForTests();
  });

  it('routes the element once and only moves the gain on volume changes', () => {
    render(1);
    render(1.5);
    render(0.5);
    render(2);

    expect(fake.ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(fake.ctx.close).not.toHaveBeenCalled();
    const targets = fake.gainParam.setTargetAtTime.mock.calls.map((call) => call[0]);
    expect(targets).toEqual([1, 1.5, 0.5, 2]);
    expect(media.muted).toBe(false);
  });

  it('keeps the routing when the element is reused for another clip', () => {
    render(1, 'clip-1');
    render(1, 'clip-2');
    expect(fake.ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it('falls back to native volume when Web Audio routing fails', () => {
    fake.ctx.createMediaElementSource.mockImplementation(() => {
      throw new DOMException('already connected', 'InvalidStateError');
    });
    render(0.4);
    expect(media.volume).toBeCloseTo(0.4);
    render(0);
    expect(media.muted).toBe(true);
  });
});
