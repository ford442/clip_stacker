/**
 * Centralized `AudioContext` construction.
 *
 * Every AudioContext in the app (playback graph, waveform peak extraction,
 * legacy canvas-renderer clip analysis, per-clip volume routing) previously
 * called `new AudioContext()` independently with no options, leaving the
 * browser's default sample rate (commonly 44.1kHz) in effect even though
 * export premixes audio at 48kHz AAC — forcing extra resamples and fighting
 * the time-stretch worklet. This is the one place that decides the options
 * for every AudioContext the app creates, so they all agree on a sample
 * rate instead of drifting independently.
 */

/** Matches the 48kHz AAC premix used by WebCodecs/FFmpeg export. */
export const PREVIEW_SAMPLE_RATE = 48_000;

export interface CreateAudioContextOptions {
  latencyHint?: AudioContextLatencyCategory | number;
  sampleRate?: number;
}

/**
 * Create an AudioContext with `latencyHint: 'interactive'` and
 * `sampleRate: 48000` by default. Some implementations reject an explicit
 * `sampleRate` they can't honor (throwing `NotSupportedError`) rather than
 * resampling — if that happens, retry once at the platform's default rate
 * so callers still get a working context instead of a hard failure.
 *
 * Throws if no AudioContext constructor exists in this environment (older
 * Safari's `webkitAudioContext` is accepted as a fallback); callers that
 * need to degrade gracefully (autoplay policy, no Web Audio support) should
 * wrap this in a try/catch, as the existing call sites already do.
 */
export function createAudioContext(options: CreateAudioContextOptions = {}): AudioContext {
  const Ctx =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : typeof AudioContext !== 'undefined'
        ? AudioContext
        : undefined;
  if (!Ctx) throw new Error('AudioContext is not available in this environment');

  const latencyHint = options.latencyHint ?? 'interactive';
  const sampleRate = options.sampleRate ?? PREVIEW_SAMPLE_RATE;

  try {
    return new Ctx({ latencyHint, sampleRate });
  } catch {
    return new Ctx({ latencyHint });
  }
}

let sharedContext: AudioContext | null = null;
let gestureListenerInstalled = false;

/** Resume `ctx` if the autoplay policy left it suspended. Never throws. */
export function resumeAudioContext(ctx: AudioContext): void {
  if (ctx.state !== 'suspended') return;
  ctx.resume().catch(() => undefined);
}

/**
 * The one AudioContext shared by element-routed preview audio (per-clip volume
 * on `<audio>` / `<video>`). Created lazily; never closed, because a
 * `MediaElementAudioSourceNode` binds its element to its context for good —
 * closing it would silence the element for the rest of its life.
 *
 * Browsers create it suspended until a user gesture, so the first call also
 * installs a one-shot pointer/key listener that resumes it.
 */
export function getSharedAudioContext(): AudioContext {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  sharedContext = createAudioContext();
  if (!gestureListenerInstalled && typeof window !== 'undefined' && window.addEventListener) {
    gestureListenerInstalled = true;
    const onGesture = () => {
      if (sharedContext) resumeAudioContext(sharedContext);
      if (sharedContext?.state !== 'suspended') {
        window.removeEventListener('pointerdown', onGesture, true);
        window.removeEventListener('keydown', onGesture, true);
        gestureListenerInstalled = false;
      }
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }
  return sharedContext;
}

/** Test-only: forget the shared context. */
export function __resetSharedAudioContextForTests(): void {
  sharedContext = null;
  gestureListenerInstalled = false;
}
