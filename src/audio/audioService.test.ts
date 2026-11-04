import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAudioServiceForTests,
  applyPreferredLatency,
  audioContextLatency,
  getAudioContext,
  heardContextTime,
  latencyChangePending,
  noteElementBinding,
  onAudioContextReplaced,
  outputLatencySec,
  peekAudioContext,
  preferAudioLatency,
  resumeAudio,
} from './audioService';

class FakeContext {
  static made: FakeContext[] = [];
  state: AudioContextState = 'suspended';
  currentTime = 0;
  baseLatency = 0.01;
  outputLatency: number | undefined = 0.04;
  latencyHint: unknown;
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  constructor(options?: { latencyHint?: unknown }) {
    this.latencyHint = options?.latencyHint;
    FakeContext.made.push(this);
  }
}

const asCtx = (c: FakeContext) => c as unknown as AudioContext;

describe('audioService', () => {
  beforeEach(() => {
    FakeContext.made = [];
    __resetAudioServiceForTests();
    vi.stubGlobal('AudioContext', FakeContext);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAudioServiceForTests();
  });

  it('creates one lazy interactive context', () => {
    expect(peekAudioContext()).toBeNull();
    const a = getAudioContext();
    const b = getAudioContext();
    expect(a).toBe(b);
    expect(FakeContext.made).toHaveLength(1);
    expect(FakeContext.made[0].latencyHint).toBe('interactive');
    expect(peekAudioContext()).toBe(a);
  });

  it('returns null without Web Audio and does not keep retrying', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(getAudioContext()).toBeNull();
    vi.stubGlobal('AudioContext', FakeContext);
    expect(getAudioContext()).toBeNull();
  });

  it('resumes on request and on the first user gesture', async () => {
    expect(await resumeAudio()).toBe(true);
    __resetAudioServiceForTests();
    FakeContext.made = [];
    getAudioContext();
    window.dispatchEvent(new Event('pointerdown'));
    expect(FakeContext.made[0].resume).toHaveBeenCalled();
  });

  it('closes on pagehide, and only suspends for the back/forward cache', () => {
    getAudioContext();
    const ctx = FakeContext.made[0];
    const persisted = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(persisted, 'persisted', { value: true });
    window.dispatchEvent(persisted);
    expect(ctx.suspend).toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();

    const gone = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(gone, 'persisted', { value: false });
    window.dispatchEvent(gone);
    expect(ctx.close).toHaveBeenCalled();
    expect(peekAudioContext()).toBeNull();
    // The next caller gets a fresh one.
    expect(getAudioContext()).not.toBe(asCtx(ctx));
  });

  it('replaces the context for a new latency class only when idle and unbound', () => {
    const first = getAudioContext()!;
    const replaced = vi.fn();
    onAudioContextReplaced(replaced);

    preferAudioLatency('balanced');
    expect(latencyChangePending()).toBe(true);
    expect(applyPreferredLatency(false)).toBe(first);  // busy: waits
    expect(FakeContext.made).toHaveLength(1);

    const next = applyPreferredLatency(true);
    expect(next).not.toBe(first);
    expect(audioContextLatency()).toBe('balanced');
    expect(FakeContext.made[1].latencyHint).toBe('balanced');
    expect(replaced).toHaveBeenCalledWith(next, first);
    expect(FakeContext.made[0].close).toHaveBeenCalled();
    expect(latencyChangePending()).toBe(false);

    // A bound media element pins the context for good.
    noteElementBinding(next!);
    preferAudioLatency('interactive');
    expect(applyPreferredLatency(true)).toBe(next);
    expect(FakeContext.made).toHaveLength(2);
  });

  it('reports output latency, falling back to the base latency', () => {
    const ctx = new FakeContext();
    expect(outputLatencySec(asCtx(ctx))).toBe(0.04);
    ctx.outputLatency = undefined;
    expect(outputLatencySec(asCtx(ctx))).toBe(0.01);
    ctx.baseLatency = Number.NaN;
    expect(outputLatencySec(asCtx(ctx))).toBe(0);
  });

  it('reads the heard time from the output timestamp, else currentTime - latency', () => {
    const ctx = new FakeContext() as FakeContext & { getOutputTimestamp?: () => AudioTimestamp };
    ctx.currentTime = 5;
    expect(heardContextTime(asCtx(ctx))).toBeCloseTo(4.96, 12);

    ctx.getOutputTimestamp = () => ({ contextTime: 4.8, performanceTime: 1000 });
    expect(heardContextTime(asCtx(ctx), () => 1100)).toBeCloseTo(4.9, 12);
    // Never ahead of the render clock, even from a stale stamp.
    expect(heardContextTime(asCtx(ctx), () => 9000)).toBe(5);
    // A zero stamp (not started yet) falls back.
    ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
    expect(heardContextTime(asCtx(ctx))).toBeCloseTo(4.96, 12);
  });
});
