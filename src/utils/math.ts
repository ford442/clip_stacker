/**
 * Small numeric helpers shared across the app. NaN handling differs between
 * them on purpose — pick the one whose behaviour the call site relies on.
 */

/**
 * Clamp `value` into `[min, max]`. NaN stays NaN. If the bounds are inverted
 * (`min > max`), `max` wins — callers clamping a trim end against a source
 * shorter than the minimum length rely on that.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp into `[0, 1]`. NaN stays NaN (see {@link clamp01Finite}). */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Clamp into `[0, 1]`, returning `fallback` for any non-finite input — note
 * that includes `Infinity`, which does not become 1.
 */
export function clamp01Finite(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** `v` when it is a finite number, otherwise `fallback` (for untrusted settings). */
export function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
