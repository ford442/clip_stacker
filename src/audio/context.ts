/**
 * `AudioContext` construction: the options every real-time context gets.
 *
 * Only `audioService.ts` calls `createAudioContext` — the app has one
 * real-time context (`getAudioContext()`), and decoding goes through
 * `decodeAudio` on an `OfflineAudioContext`. `context.boundary.test.ts`
 * fails if anything else constructs one.
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

/** Resume `ctx` if the autoplay policy left it suspended. Never throws. */
export function resumeAudioContext(ctx: AudioContext): void {
  if (ctx.state !== 'suspended') return;
  ctx.resume().catch(() => undefined);
}
