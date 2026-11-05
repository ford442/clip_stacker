/**
 * The app's one real-time `AudioContext`.
 *
 * Playback (`playbackManager.ts`), element routing (`useMediaVolume`) and the
 * legacy canvas export's audio-reactive analysis all share it; decoding never
 * needs a real-time context and goes through `decodeAudio` (an
 * `OfflineAudioContext`) instead. One context means one output stream, one
 * clock, one place that handles the autoplay policy, and one `pagehide`.
 *
 * - **Lazy.** Created on first `getContext()`; browsers start it suspended
 *   until a user gesture, so the first call installs a one-shot pointer /
 *   key listener that resumes it.
 * - **Closed on `pagehide`** (unless the page goes into the back/forward
 *   cache, where it is only suspended and resumed on `pageshow`).
 * - **Latency class.** `'interactive'` by default; the playback manager asks
 *   for `'balanced'` while the bus-graph AudioWorklet is in the graph (its
 *   WASM render can then take most of a quantum without glitching). A
 *   context's latency hint is fixed at construction, so a change is applied
 *   by replacing the context — only when that is safe: nothing playing
 *   through it (the owner says when) and no media element bound to it (a
 *   `MediaElementAudioSourceNode` binds its element to its context for
 *   good). Otherwise the preference waits.
 */

import { createAudioContext } from './context';

export type AudioLatencyClass = 'interactive' | 'balanced';

type ContextListener = (next: AudioContext, previous: AudioContext) => void;

let context: AudioContext | null = null;
let contextLatency: AudioLatencyClass = 'interactive';
let preferredLatency: AudioLatencyClass = 'interactive';
let elementBindings = 0;
let failed = false;
let gestureInstalled = false;
let pageListenersInstalled = false;
const listeners = new Set<ContextListener>();

function resumeQuietly(ctx: AudioContext): void {
  if (ctx.state !== 'suspended') return;
  ctx.resume().catch(() => undefined);
}

function installGestureResume(): void {
  if (gestureInstalled || typeof window === 'undefined' || !window.addEventListener) return;
  gestureInstalled = true;
  const onGesture = () => {
    if (context) resumeQuietly(context);
    if (!context || context.state !== 'suspended') {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      gestureInstalled = false;
    }
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
}

function installPageListeners(): void {
  if (pageListenersInstalled || typeof window === 'undefined' || !window.addEventListener) return;
  pageListenersInstalled = true;
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    const ctx = context;
    if (!ctx) return;
    if (event.persisted) {
      // Back/forward cache: keep the graph, stop the output.
      ctx.suspend?.().catch(() => undefined);
      return;
    }
    context = null;
    elementBindings = 0;
    ctx.close().catch(() => undefined);
  });
  window.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (event.persisted && context) resumeQuietly(context);
  });
}

function create(latency: AudioLatencyClass): AudioContext | null {
  if (failed) return null;
  try {
    const ctx = createAudioContext({ latencyHint: latency });
    contextLatency = latency;
    installGestureResume();
    installPageListeners();
    return ctx;
  } catch {
    failed = true;
    return null;
  }
}

/** The shared real-time context, created on first use. Null when Web Audio is unavailable. */
export function getAudioContext(): AudioContext | null {
  if (context && context.state !== 'closed') return context;
  context = create(preferredLatency);
  elementBindings = 0;
  return context;
}

/** The context if it exists already (never creates one). */
export function peekAudioContext(): AudioContext | null {
  return context && context.state !== 'closed' ? context : null;
}

/** Resume a suspended context — call from a user gesture. True when it runs. */
export async function resumeAudio(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === 'running';
}

/**
 * Record that a media element was routed into the current context
 * (`createMediaElementSource`): from now on it is never replaced.
 */
export function noteElementBinding(ctx: AudioContext): void {
  if (ctx === context) elementBindings += 1;
}

/** The latency class the context was created with. */
export function audioContextLatency(): AudioLatencyClass {
  return contextLatency;
}

/** Ask for a latency class; applied when a context is (re)created. */
export function preferAudioLatency(latency: AudioLatencyClass): void {
  preferredLatency = latency;
}

/** True when `applyPreferredLatency` would replace the context now. */
export function latencyChangePending(): boolean {
  return context !== null && context.state !== 'closed' && contextLatency !== preferredLatency;
}

/**
 * Replace the context with one at the preferred latency, if it differs and
 * that is safe. `idle` is the caller's word that nothing it scheduled is
 * playing. Listeners get (next, previous) before the previous one closes, so
 * they rebuild their nodes on the new context. Returns the context in use.
 */
export function applyPreferredLatency(idle: boolean): AudioContext | null {
  const previous = peekAudioContext();
  if (!previous || contextLatency === preferredLatency) return previous;
  if (!idle || elementBindings > 0) return previous;
  const next = create(preferredLatency);
  if (!next) {
    failed = false;  // the old context still works; keep using it
    return previous;
  }
  context = next;
  elementBindings = 0;
  for (const listener of listeners) {
    try {
      listener(next, previous);
    } catch (err) {
      console.warn('[audio] context listener failed', err);
    }
  }
  previous.close().catch(() => undefined);
  return next;
}

/** Called when `applyPreferredLatency` replaces the context. */
export function onAudioContextReplaced(listener: ContextListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Seconds from a context time being rendered to it being heard: the
 * device's output latency (Bluetooth adds 150–250 ms) when the browser
 * reports it, else the base latency. Never negative.
 */
export function outputLatencySec(ctx: BaseAudioContext): number {
  const rt = ctx as Partial<AudioContext>;
  const output = rt.outputLatency;
  if (typeof output === 'number' && Number.isFinite(output) && output > 0) return output;
  const base = rt.baseLatency;
  return typeof base === 'number' && Number.isFinite(base) && base > 0 ? base : 0;
}

/**
 * The context time the listener hears right now. `getOutputTimestamp()` is
 * the browser's own measurement (the context time leaving the device at a
 * `performance.now()` instant); it is extrapolated to now. Without it,
 * `currentTime - outputLatency`.
 */
export function heardContextTime(
  ctx: AudioContext,
  nowMs: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
): number {
  const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : undefined;
  if (
    stamp &&
    typeof stamp.contextTime === 'number' &&
    typeof stamp.performanceTime === 'number' &&
    stamp.contextTime > 0 &&
    stamp.performanceTime > 0
  ) {
    const heard = stamp.contextTime + Math.max(0, nowMs() - stamp.performanceTime) / 1000;
    // A stale stamp (suspended device) must not run ahead of the render clock.
    return Math.min(ctx.currentTime, heard);
  }
  return ctx.currentTime - outputLatencySec(ctx);
}

/** Test-only: forget the context and every preference. */
export function __resetAudioServiceForTests(): void {
  context = null;
  contextLatency = 'interactive';
  preferredLatency = 'interactive';
  elementBindings = 0;
  failed = false;
  listeners.clear();
}
