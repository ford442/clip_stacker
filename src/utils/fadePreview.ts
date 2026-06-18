import { MIN_CLIP_DURATION } from './media';

export type FadeDirection = 'in' | 'out';

export interface FadePreviewTiming {
  seekTime: number;
  elapsed: number;
  previewDuration: number;
}

/** Resolve trim end and preview window length for fade preview. */
export function resolveFadePreviewWindow(
  trimStart: number,
  trimEnd: number,
  clipDuration: number,
): { end: number; previewDuration: number } {
  const end = Number.isFinite(trimEnd) ? trimEnd : clipDuration;
  const previewDuration = Math.max(MIN_CLIP_DURATION, end - trimStart);
  return { end, previewDuration };
}

/**
 * Pick the representative preview time for a fade control.
 * Fade-in: trimStart + fadeDuration/2. Fade-out: trimEnd - fadeDuration/2.
 */
export function getFadePreviewTiming(
  direction: FadeDirection,
  trimStart: number,
  trimEnd: number,
  clipDuration: number,
  fadeDuration: number,
): FadePreviewTiming {
  const { end, previewDuration } = resolveFadePreviewWindow(trimStart, trimEnd, clipDuration);

  if (fadeDuration <= 0) {
    const seekTime = direction === 'in' ? trimStart : end;
    return {
      seekTime,
      elapsed: Math.max(0, seekTime - trimStart),
      previewDuration,
    };
  }

  const seekTime =
    direction === 'in'
      ? trimStart + fadeDuration / 2
      : Math.max(trimStart, end - fadeDuration / 2);

  return {
    seekTime,
    elapsed: Math.max(0, seekTime - trimStart),
    previewDuration,
  };
}

/** Match render-path fade math (FFmpeg / canvas / WebCodecs). */
export function computeFadeAlpha(
  elapsed: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
): number {
  let alpha = 1;
  if (fadeIn > 0 && elapsed < fadeIn) alpha = Math.min(alpha, elapsed / fadeIn);
  if (fadeOut > 0 && duration > 0 && elapsed > duration - fadeOut) {
    alpha = Math.min(alpha, (duration - elapsed) / fadeOut);
  }
  return Math.max(0, Math.min(1, alpha));
}

/** Opacity at the representative preview frame for a single fade control. */
export function computeFadePreviewAlpha(
  direction: FadeDirection,
  timing: FadePreviewTiming,
  fadeDuration: number,
): number {
  if (fadeDuration <= 0) return 1;
  const fadeIn = direction === 'in' ? fadeDuration : 0;
  const fadeOut = direction === 'out' ? fadeDuration : 0;
  return computeFadeAlpha(timing.elapsed, timing.previewDuration, fadeIn, fadeOut);
}
