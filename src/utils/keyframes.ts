/**
 * Keyframe sampling — linear and cubic-bezier easing between keyframes.
 */

export interface KeyframeEasing {
  type: 'linear' | 'bezier';
  /** Cubic-bezier control points (0–1) used when type is 'bezier'. */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

export interface Keyframe {
  /** Local time in seconds. */
  t: number;
  value: number;
  /** Easing from this keyframe toward the next (defaults to linear). */
  easing?: KeyframeEasing;
}

export const DEFAULT_LINEAR_EASING: KeyframeEasing = { type: 'linear' };

/** Preset bezier curves (CSS-compatible control points). */
export const EASING_PRESETS = {
  easeIn: { type: 'bezier' as const, x1: 0.42, y1: 0, x2: 1, y2: 1 },
  easeOut: { type: 'bezier' as const, x1: 0, y1: 0, x2: 0.58, y2: 1 },
  easeInOut: { type: 'bezier' as const, x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
};

export function sortKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.t - b.t);
}

/** Sample a scalar track at local time `t` (seconds). */
export function sampleKeyframes(
  keyframes: Keyframe[] | undefined,
  t: number,
  defaultValue: number,
): number {
  if (!keyframes || keyframes.length === 0) return defaultValue;

  const track = sortKeyframes(keyframes);
  if (track.length === 1) return track[0].value;

  if (t <= track[0].t) return track[0].value;
  const last = track[track.length - 1];
  if (t >= last.t) return last.value;

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.value;
      const rawU = (t - a.t) / span;
      const easedU = applyEasing(rawU, a.easing);
      return a.value + (b.value - a.value) * easedU;
    }
  }

  return last.value;
}

export function applyEasing(u: number, easing: KeyframeEasing | undefined): number {
  const clamped = Math.max(0, Math.min(1, u));
  const e = easing ?? DEFAULT_LINEAR_EASING;
  if (e.type === 'linear') return clamped;
  return cubicBezier(clamped, e.x1 ?? 0, e.y1 ?? 0, e.x2 ?? 1, e.y2 ?? 1);
}

/**
 * CSS cubic-bezier easing — solves y(t) for given x=u using Newton iteration.
 * Control points are in unit square (standard CSS semantics).
 */
export function cubicBezier(
  u: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const targetX = Math.max(0, Math.min(1, u));
  if (targetX <= 0) return 0;
  if (targetX >= 1) return 1;

  let t = targetX;
  for (let i = 0; i < 8; i++) {
    const x =
      3 * (1 - t) * (1 - t) * t * x1 +
      3 * (1 - t) * t * t * x2 +
      t * t * t -
      targetX;
    const dx =
      3 * (1 - t) * (1 - t) * x1 +
      6 * (1 - t) * t * (x2 - x1) +
      3 * t * t * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    t -= x / dx;
    t = Math.max(0, Math.min(1, t));
  }

  return (
    3 * (1 - t) * (1 - t) * t * y1 +
    3 * (1 - t) * t * t * y2 +
    t * t * t
  );
}

export function upsertKeyframe(
  keyframes: Keyframe[] | undefined,
  t: number,
  value: number,
  mergeEpsilon = 0.02,
): Keyframe[] {
  const track = sortKeyframes(keyframes ?? []);
  const existing = track.findIndex((k) => Math.abs(k.t - t) <= mergeEpsilon);
  if (existing >= 0) {
    const next = [...track];
    next[existing] = { ...next[existing], t, value };
    return sortKeyframes(next);
  }
  return sortKeyframes([...track, { t, value }]);
}

export function removeKeyframeAt(
  keyframes: Keyframe[] | undefined,
  t: number,
  mergeEpsilon = 0.02,
): Keyframe[] | undefined {
  if (!keyframes?.length) return undefined;
  const next = keyframes.filter((k) => Math.abs(k.t - t) > mergeEpsilon);
  return next.length > 0 ? sortKeyframes(next) : undefined;
}
