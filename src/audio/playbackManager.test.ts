import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { ClipAudioCache } from './clipAudioCache';
import {
  applyGainEnvelope,
  applyPanEnvelope,
  AudioPlaybackManager,
  disposeAudioPlaybackManager,
  getAudioPlaybackManager,
} from './playbackManager';

function makeClip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

class FakeAudioParam {
  value = 1;
  events: Array<{ type: string; value?: number; time: number }> = [];

  cancelScheduledValues(time: number) {
    this.events.push({ type: 'cancel', time });
  }

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: 'ramp', value, time });
    return this;
  }
}

describe('applyGainEnvelope', () => {
  it('starts at full volume when no fades', () => {
    const param = new FakeAudioParam();
    applyGainEnvelope(
      param as unknown as AudioParam,
      { volume: 1.5, audioFadeIn: 0, audioFadeOut: 0, duration: 4 },
      1,
      4,
      0,
      0,
    );
    expect(param.events.some((e) => e.type === 'set' && e.value === 1.5)).toBe(
      true,
    );
  });

  it('ramps in from silence over audioFadeIn', () => {
    const param = new FakeAudioParam();
    applyGainEnvelope(
      param as unknown as AudioParam,
      { volume: 1, audioFadeIn: 0.5, audioFadeOut: 0, duration: 4 },
      2,
      4,
      0,
      0,
    );
    const setEvent = param.events.find((e) => e.type === 'set');
    expect(setEvent).toMatchObject({ type: 'set', value: 0, time: 2 });
    expect(param.events.some((e) => e.type === 'ramp' && e.value === 1)).toBe(
      true,
    );
  });

  it('continues mid-fade when seeking into fade-in', () => {
    const param = new FakeAudioParam();
    applyGainEnvelope(
      param as unknown as AudioParam,
      { volume: 1, audioFadeIn: 1, audioFadeOut: 0, duration: 4 },
      0,
      3.5,
      0.25,
      0,
    );
    const setEvent = param.events.find((e) => e.type === 'set');
    expect(setEvent?.value).toBeCloseTo(0.25);
  });

  it('schedules absolute volume automation keyframes', () => {
    const param = new FakeAudioParam();
    applyGainEnvelope(
      param as unknown as AudioParam,
      {
        volume: 1,
        audioFadeIn: 0,
        audioFadeOut: 0,
        duration: 4,
        volumeAutomation: [
          { t: 0, value: 1 },
          { t: 1, value: 0.2 },
          { t: 2, value: 1.5 },
        ],
      },
      0,
      4,
      0,
      0,
    );
    expect(param.events.some((e) => e.type === 'set' && e.value === 1)).toBe(true);
    const dip = param.events.find((e) => e.type === 'ramp' && e.time === 1);
    expect(dip?.value).toBeCloseTo(0.2);
    expect(param.events.some((e) => e.type === 'ramp' && e.value === 1.5 && e.time === 2)).toBe(
      true,
    );
  });

  it('multiplies fade envelope on top of volume automation', () => {
    const param = new FakeAudioParam();
    applyGainEnvelope(
      param as unknown as AudioParam,
      {
        volume: 1,
        audioFadeIn: 1,
        audioFadeOut: 0,
        duration: 4,
        volumeAutomation: [
          { t: 0, value: 1 },
          { t: 1, value: 1 },
        ],
      },
      0,
      4,
      0,
      0,
    );
    const start = param.events.find((e) => e.type === 'set');
    expect(start?.value).toBeCloseTo(0);
  });
});

describe('applyGainEnvelope on a looped clip (per-cycle sources, global fade window)', () => {
  // A 12s-total, 4-cycle (3s each) looped clip with 0.5s fades. Each loop
  // cycle gets its own AudioBufferSourceNode/GainNode, but fades and
  // volume/pan automation are authored (and sampled) across the WHOLE
  // looped span — the Inspector's automation editor shows the full 12s,
  // not one 3s cycle — so only the true first/last cycle should show a
  // fade ramp; interior cycles stay flat at full volume.
  const entry = {
    volume: 1,
    audioFadeIn: 0.5,
    audioFadeOut: 0.5,
    duration: 12,
  };

  it('fades in only on the first cycle (global elapsed 0)', () => {
    const param = new FakeAudioParam();
    applyGainEnvelope(param as unknown as AudioParam, entry, 0, 3, 0, 0);
    const setEvent = param.events.find((e) => e.type === 'set');
    expect(setEvent).toMatchObject({ type: 'set', value: 0, time: 0 });
    expect(param.events.some((e) => e.type === 'ramp' && e.value === 1)).toBe(true);
  });

  it('stays flat at full volume on interior cycles (global elapsed 3s, 6s)', () => {
    for (const globalElapsed of [3, 6]) {
      const param = new FakeAudioParam();
      applyGainEnvelope(param as unknown as AudioParam, entry, 0, 3, globalElapsed, 0);
      expect(param.events.every((e) => e.value === undefined || e.value === 1)).toBe(true);
    }
  });

  it('fades out only on the last cycle (global elapsed 9s, ending at 12s)', () => {
    const param = new FakeAudioParam();
    applyGainEnvelope(param as unknown as AudioParam, entry, 0, 3, 9, 0);
    const lastRamp = [...param.events].reverse().find((e) => e.type === 'ramp');
    expect(lastRamp?.value).toBeCloseTo(0);
    expect(lastRamp?.time).toBeCloseTo(3);
  });
});

describe('applyPanEnvelope', () => {
  it('centers pan when automation is empty', () => {
    const param = new FakeAudioParam();
    applyPanEnvelope(param as unknown as AudioParam, undefined, 1, 2, 0, 0, 2);
    expect(param.events.some((e) => e.type === 'set' && e.value === 0 && e.time === 1)).toBe(
      true,
    );
  });

  it('ramps pan automation across keyframes', () => {
    const param = new FakeAudioParam();
    applyPanEnvelope(
      param as unknown as AudioParam,
      [
        { t: 0, value: -1 },
        { t: 2, value: 1 },
      ],
      0,
      2,
      0,
      0,
      2,
    );
    expect(param.events.some((e) => e.type === 'set' && e.value === -1)).toBe(true);
    expect(param.events.some((e) => e.type === 'ramp' && e.value === 1 && e.time === 2)).toBe(
      true,
    );
  });
});

describe('ClipAudioCache', () => {
  it('caches by clip id and invalidates on objectUrl change', async () => {
    const cache = new ClipAudioCache();
    const bufferA = { duration: 1 } as AudioBuffer;
    const bufferB = { duration: 2 } as AudioBuffer;
    const decode = vi
      .fn()
      .mockResolvedValueOnce(bufferA)
      .mockResolvedValueOnce(bufferB);

    const ctx = {
      decodeAudioData: decode,
    } as unknown as BaseAudioContext;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const first = await cache.get('c1', 'blob:a', ctx);
    const second = await cache.get('c1', 'blob:a', ctx);
    expect(first).toBe(bufferA);
    expect(second).toBe(bufferA);
    expect(decode).toHaveBeenCalledTimes(1);

    const third = await cache.get('c1', 'blob:b', ctx);
    expect(third).toBe(bufferB);
    expect(decode).toHaveBeenCalledTimes(2);

    cache.prune(new Set(['other']));
    expect(cache.size).toBe(0);

    vi.unstubAllGlobals();
  });
});

describe('AudioPlaybackManager lifecycle', () => {
  afterEach(async () => {
    await disposeAudioPlaybackManager();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns the same singleton until disposed', async () => {
    const a = getAudioPlaybackManager();
    const b = getAudioPlaybackManager();
    expect(a).toBe(b);
    await disposeAudioPlaybackManager();
    const c = getAudioPlaybackManager();
    expect(c).not.toBe(a);
  });

  it('falls back gracefully when AudioContext is unavailable', async () => {
    const original = window.AudioContext;
    // @ts-expect-error force missing constructor
    window.AudioContext = undefined;
    (
      window as unknown as { webkitAudioContext?: undefined }
    ).webkitAudioContext = undefined;

    const manager = new AudioPlaybackManager();
    const ok = await manager.ensureContext();
    expect(ok).toBe(false);
    expect(manager.isAvailable).toBe(false);

    const played = await manager.play(1.25);
    expect(played).toBe(false);
    expect(manager.getCurrentTime()).toBe(1.25);

    window.AudioContext = original;
    await manager.dispose();
  });

  it('tracks paused time across seek while stopped', async () => {
    const manager = new AudioPlaybackManager();
    await manager.seek(3.5);
    expect(manager.getCurrentTime()).toBe(3.5);
    expect(manager.getStatus().state).toBe('stopped');
    await manager.dispose();
  });

  it('syncTimeline builds schedule without throwing for empty timeline', async () => {
    const manager = new AudioPlaybackManager();
    await manager.syncTimeline([], [], []);
    await manager.dispose();
  });

  it('syncTimeline accepts multi-clip timelines', async () => {
    const manager = new AudioPlaybackManager();
    await manager.syncTimeline(
      [makeClip('a', 2), makeClip('b', 3, { volume: 0.5 })],
      [],
      [],
    );
    await manager.dispose();
  });

  it('syncTimeline accepts clips with volume automation', async () => {
    const manager = new AudioPlaybackManager();
    await manager.syncTimeline(
      [
        makeClip('a', 2, {
          automation: {
            volume: [
              { t: 0, value: 1 },
              { t: 1, value: 0.25 },
            ],
            pan: [
              { t: 0, value: -0.5 },
              { t: 2, value: 0.5 },
            ],
          },
        }),
      ],
      [],
      [],
    );
    await manager.dispose();
  });

  it('clamps master volume and returns zero analyser levels without a context', async () => {
    const manager = new AudioPlaybackManager();
    manager.setMasterVolume(5);
    expect(manager.getMasterVolume()).toBe(2);
    manager.setMasterVolume(-1);
    expect(manager.getMasterVolume()).toBe(0);
    expect(manager.readAnalyserLevels()).toEqual({
      rms: 0,
      peak: 0,
      bass: 0,
      mid: 0,
      treble: 0,
    });
    await manager.dispose();
  });
});
