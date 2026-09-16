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
