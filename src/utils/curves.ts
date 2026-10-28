/**
 * Curves & levels — finishing pass after primary color, before secondary.
 *
 * Per pixel, per channel: levels (input black / white, gamma, output black /
 * white) → master curve → that channel's curve, then mixed with the source by
 * `amount`. Curves are monotone cubic (Fritsch–Carlson) through ≤ 16 knots:
 * smooth, exactly through every knot, and never overshooting between them
 * (no ringing a natural spline gives on a steep edit). Outside the first /
 * last knot a curve is flat, as in the usual curve editors.
 *
 * The shader evaluates the same spline from knots + slopes in a uniform
 * array (`packCurvesUniforms`), so there is no LUT texture and no
 * quantization; `curvesPixel` below is the CPU reference it mirrors.
 *
 * WebGPU only (preview + GPU export). The FFmpeg path skips it and reports it
 * in `RenderPlan.ffmpegFinishingGaps`; Canvas2D does not apply finishing.
 */

import { clamp, clamp01, finiteOr } from './math';

export interface CurvePoint {
  x: number;
  y: number;
}

export type CurveChannel = 'master' | 'red' | 'green' | 'blue';

export const CURVE_CHANNELS: readonly CurveChannel[] = ['master', 'red', 'green', 'blue'];

export interface LevelsSettings {
  /** Input black point 0 … 1 (values at or below map to output black). */
  inBlack: number;
  /** Input white point 0 … 1 (values at or above map to output white). */
  inWhite: number;
  /** Midtone gamma 0.1 … 10; > 1 brightens midtones (exponent 1/gamma). */
  gamma: number;
  /** Output black 0 … 1. */
  outBlack: number;
  /** Output white 0 … 1. */
  outWhite: number;
}

export interface CurvesSettings {
  enabled: boolean;
  /** Mix with the source 0 (bypass) → 1. */
  amount?: number;
  levels: LevelsSettings;
  /** Knots per channel, sorted by x. Empty / identity = no change. */
  curves: Record<CurveChannel, CurvePoint[]>;
}

export const CURVE_MAX_POINTS = 16;
/** Two knots closer than this in x are merged (keeps the spline well-posed). */
export const CURVE_MIN_SPACING = 0.01;
export const LEVELS_GAMMA_MIN = 0.1;
export const LEVELS_GAMMA_MAX = 10;

/** 3 header vec4s + 4 curves × 16 knots (x, y, slope, pad). */
export const CURVES_UNIFORM_FLOATS = 12 + 4 * CURVE_MAX_POINTS * 4;

export const IDENTITY_CURVE: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const DEFAULT_LEVELS: LevelsSettings = {
  inBlack: 0,
  inWhite: 1,
  gamma: 1,
  outBlack: 0,
  outWhite: 1,
};

export function identityCurves(): Record<CurveChannel, CurvePoint[]> {
  return {
    master: IDENTITY_CURVE.map((p) => ({ ...p })),
    red: IDENTITY_CURVE.map((p) => ({ ...p })),
    green: IDENTITY_CURVE.map((p) => ({ ...p })),
    blue: IDENTITY_CURVE.map((p) => ({ ...p })),
  };
}

export const DEFAULT_CURVES_PARAMS = {
  levels: { ...DEFAULT_LEVELS },
  curves: identityCurves(),
};

/** Sort, clamp to [0, 1], merge near-duplicates, cap at CURVE_MAX_POINTS. */
export function normalizeCurvePoints(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw)) return IDENTITY_CURVE.map((p) => ({ ...p }));
  const pts = raw
    .filter(
      (p): p is CurvePoint =>
        Boolean(p) &&
        typeof p === 'object' &&
        Number.isFinite((p as CurvePoint).x) &&
        Number.isFinite((p as CurvePoint).y),
    )
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x);
  const out: CurvePoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && p.x - last.x < CURVE_MIN_SPACING) {
      // Keep the later point's y (the one the user most likely just dragged).
      last.y = p.y;
      continue;
    }
    out.push(p);
  }
  // A curve needs two knots; anything less is treated as untouched.
  if (out.length < 2) return IDENTITY_CURVE.map((p) => ({ ...p }));
  return out.slice(0, CURVE_MAX_POINTS);
}

export function isIdentityCurve(points: readonly CurvePoint[] | undefined): boolean {
  if (!points || points.length === 0) return true;
  // Monotone cubic through points on y = x is the line y = x itself, but only
  // over [first.x, last.x]; flat extension outside clips unless the ends are 0 / 1.
  const onDiagonal = points.every((p) => Math.abs(p.y - p.x) < 1e-6);
  return onDiagonal && points[0].x <= 1e-6 && points[points.length - 1].x >= 1 - 1e-6;
}

export function isLevelsIdentity(levels: LevelsSettings | undefined): boolean {
  if (!levels) return true;
  const d = DEFAULT_LEVELS;
  return (
    Math.abs(levels.inBlack - d.inBlack) < 1e-6 &&
    Math.abs(levels.inWhite - d.inWhite) < 1e-6 &&
    Math.abs(levels.gamma - d.gamma) < 1e-6 &&
    Math.abs(levels.outBlack - d.outBlack) < 1e-6 &&
    Math.abs(levels.outWhite - d.outWhite) < 1e-6
  );
}

export function isCurvesNeutral(pass: CurvesSettings | undefined): boolean {
  if (!pass?.enabled) return true;
  if (finiteOr(pass.amount, 1) <= 1e-6) return true;
  return (
    isLevelsIdentity(pass.levels) &&
    CURVE_CHANNELS.every((c) => isIdentityCurve(pass.curves?.[c]))
  );
}

export function normalizeLevels(raw: Partial<LevelsSettings> | undefined): LevelsSettings {
  const d = DEFAULT_LEVELS;
  if (!raw || typeof raw !== 'object') return { ...d };
  let inBlack = clamp01(finiteOr(raw.inBlack, d.inBlack));
  let inWhite = clamp01(finiteOr(raw.inWhite, d.inWhite));
  // Keep a usable input range; an inverted / collapsed range would divide by ~0.
  if (inWhite - inBlack < CURVE_MIN_SPACING) {
    if (inBlack + CURVE_MIN_SPACING <= 1) inWhite = inBlack + CURVE_MIN_SPACING;
    else inBlack = inWhite - CURVE_MIN_SPACING;
  }
  return {
    inBlack,
    inWhite,
    gamma: clamp(finiteOr(raw.gamma, d.gamma), LEVELS_GAMMA_MIN, LEVELS_GAMMA_MAX),
    // Output range may be inverted on purpose (a negative).
    outBlack: clamp01(finiteOr(raw.outBlack, d.outBlack)),
    outWhite: clamp01(finiteOr(raw.outWhite, d.outWhite)),
  };
}

export function normalizeCurvesPass(
  raw: Partial<CurvesSettings> | undefined,
  defaults: CurvesSettings,
): CurvesSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      ...defaults,
      levels: { ...defaults.levels },
      curves: {
        master: defaults.curves.master.map((p) => ({ ...p })),
        red: defaults.curves.red.map((p) => ({ ...p })),
        green: defaults.curves.green.map((p) => ({ ...p })),
        blue: defaults.curves.blue.map((p) => ({ ...p })),
      },
    };
  }
  const rawCurves = (raw.curves && typeof raw.curves === 'object' ? raw.curves : {}) as Partial<
    Record<CurveChannel, unknown>
  >;
  return {
    enabled: Boolean(raw.enabled),
    amount: Number.isFinite(raw.amount) ? clamp01(raw.amount as number) : (defaults.amount ?? 1),
    levels: normalizeLevels(raw.levels),
    curves: {
      master: normalizeCurvePoints(rawCurves.master),
      red: normalizeCurvePoints(rawCurves.red),
      green: normalizeCurvePoints(rawCurves.green),
      blue: normalizeCurvePoints(rawCurves.blue),
    },
  };
}

// ---------------------------------------------------------------------------
// Monotone cubic (Fritsch–Carlson) — slopes on the CPU, Hermite eval in both.

/** Knot tangents: zero at local extrema, limited so the cubic never overshoots. */
export function monotoneSlopes(points: readonly CurvePoint[]): number[] {
  const n = points.length;
  if (n < 2) return new Array(n).fill(0);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    d.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x));
  }
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return m;
}

/**
 * Evaluate packed knots (x, y, slope) at v. Mirrors WGSL `evalCurve`:
 * flat outside [first.x, last.x], Hermite inside. `extendAbove` (scene-linear,
 * in the encoded domain) continues past x = 1 with slope 1 so HDR highlights
 * are not clipped.
 */
export function evalPackedCurve(
  knots: ArrayLike<number>,
  offset: number,
  count: number,
  v: number,
  extendAbove = false,
): number {
  if (count < 2) return v;
  const k = (i: number) => offset + i * 4;
  if (extendAbove && v > 1) return evalPackedCurve(knots, offset, count, 1) + (v - 1);
  if (v <= knots[k(0)]) return knots[k(0) + 1];
  const last = k(count - 1);
  if (v >= knots[last]) return knots[last + 1];
  let i = 0;
  while (i < count - 2 && v > knots[k(i + 1)]) i++;
  const x0 = knots[k(i)];
  const y0 = knots[k(i) + 1];
  const m0 = knots[k(i) + 2];
  const x1 = knots[k(i + 1)];
  const y1 = knots[k(i + 1) + 1];
  const m1 = knots[k(i + 1) + 2];
  const h = x1 - x0;
  const t = (v - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * h * m0 +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * h * m1
  );
}

/**
 * Pack into WGSL `CurvesUniforms`:
 *   [0..3]  levels: inBlack, inWhite, gamma, outBlack
 *   [4..7]  outWhite, amount, pad, pad
 *   [8..11] knot counts: master, red, green, blue (0 = identity, skipped)
 *   [12 + c·64 + i·4] knot i of channel c: x, y, slope, pad
 */
export function packCurvesUniforms(
  pass: CurvesSettings,
  out: Float32Array = new Float32Array(CURVES_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < CURVES_UNIFORM_FLOATS) {
    throw new Error(`Curves uniform buffer needs ${CURVES_UNIFORM_FLOATS} floats`);
  }
  out.fill(0);
  const levels = normalizeLevels(pass.levels);
  out[0] = levels.inBlack;
  out[1] = levels.inWhite;
  out[2] = levels.gamma;
  out[3] = levels.outBlack;
  out[4] = levels.outWhite;
  out[5] = pass.enabled ? clamp01(finiteOr(pass.amount, 1)) : 0;
  CURVE_CHANNELS.forEach((channel, c) => {
    const points = normalizeCurvePoints(pass.curves?.[channel]);
    if (isIdentityCurve(points)) return;
    const slopes = monotoneSlopes(points);
    out[8 + c] = points.length;
    points.forEach((p, i) => {
      const base = 12 + c * CURVE_MAX_POINTS * 4 + i * 4;
      out[base] = p.x;
      out[base + 1] = p.y;
      out[base + 2] = slopes[i];
    });
  });
  return out;
}

/** Levels on one value; mirrors WGSL `applyLevels`. */
export function applyLevelsValue(u: ArrayLike<number>, v: number, sceneLinear = false): number {
  const range = Math.max(u[1] - u[0], 1e-6);
  let n = (v - u[0]) / range;
  n = sceneLinear ? Math.max(n, 0) : clamp01(n);
  const g = Math.pow(n, 1 / u[2]);
  return u[3] + g * (u[4] - u[3]);
}

function encodeSrgb(v: number): number {
  const x = Math.max(v, 0);
  return x > 0.0031308 ? 1.055 * Math.pow(x, 1 / 2.4) - 0.055 : x * 12.92;
}

function decodeSrgb(v: number): number {
  const x = Math.max(v, 0);
  return x > 0.04045 ? Math.pow((x + 0.055) / 1.055, 2.4) : x / 12.92;
}

/**
 * One pixel of `fs_main` from packed uniforms (CPU reference). With
 * `sceneLinear` (managed colour) the grade runs in an extended sRGB encoding
 * and is decoded back, so a knot at 0.5 means mid-grey in both modes and
 * values above 1 are carried through rather than clipped.
 */
export function curvesPixel(
  rgb: readonly [number, number, number],
  u: ArrayLike<number>,
  sceneLinear = false,
): [number, number, number] {
  const amount = u[5];
  if (amount <= 0) return [rgb[0], rgb[1], rgb[2]];
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let v = sceneLinear ? encodeSrgb(rgb[k]) : rgb[k];
    v = applyLevelsValue(u, v, sceneLinear);
    v = evalPackedCurve(u, 12, u[8], v, sceneLinear);
    v = evalPackedCurve(u, 12 + (k + 1) * CURVE_MAX_POINTS * 4, u[9 + k], v, sceneLinear);
    v = sceneLinear ? decodeSrgb(v) : clamp01(v);
    out[k] = rgb[k] + (v - rgb[k]) * amount;
  }
  return out;
}

/** Sample a curve at `steps` points (UI drawing). */
export function sampleCurve(points: readonly CurvePoint[], steps = 64): CurvePoint[] {
  const norm = normalizeCurvePoints(points);
  const slopes = monotoneSlopes(norm);
  const packed = new Float32Array(norm.length * 4);
  norm.forEach((p, i) => {
    packed[i * 4] = p.x;
    packed[i * 4 + 1] = p.y;
    packed[i * 4 + 2] = slopes[i];
  });
  const out: CurvePoint[] = [];
  for (let s = 0; s <= steps; s++) {
    const x = s / steps;
    out.push({ x, y: norm.length < 2 ? (norm[0]?.y ?? x) : evalPackedCurve(packed, 0, norm.length, x) });
  }
  return out;
}

/** Named starting points for the curve editor. */
export const CURVE_PRESETS: { id: string; label: string; points: CurvePoint[] }[] = [
  { id: 'linear', label: 'Linear', points: IDENTITY_CURVE.map((p) => ({ ...p })) },
  {
    id: 'soft-s',
    label: 'Soft S',
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.2 },
      { x: 0.75, y: 0.8 },
      { x: 1, y: 1 },
    ],
  },
  {
    id: 'strong-s',
    label: 'Strong S',
    points: [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.15 },
      { x: 0.75, y: 0.86 },
      { x: 1, y: 1 },
    ],
  },
  {
    id: 'fade',
    label: 'Matte fade',
    points: [
      { x: 0, y: 0.08 },
      { x: 0.2, y: 0.2 },
      { x: 1, y: 0.95 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Editor operations (pure; the curve editor and tests use them).

/** Insert a knot at x (y defaults to the curve's current value there). */
export function insertCurvePoint(
  points: readonly CurvePoint[],
  x: number,
  y?: number,
): { points: CurvePoint[]; index: number } {
  const norm = normalizeCurvePoints(points);
  if (norm.length >= CURVE_MAX_POINTS) return { points: norm, index: -1 };
  const cx = clamp01(x);
  const tooClose = norm.findIndex((p) => Math.abs(p.x - cx) < CURVE_MIN_SPACING);
  if (tooClose >= 0) return { points: norm, index: tooClose };
  const atX = y ?? sampleCurveAt(norm, cx);
  const next = [...norm, { x: cx, y: clamp01(atX) }].sort((a, b) => a.x - b.x);
  return { points: next, index: next.findIndex((p) => p.x === cx) };
}

/** Move knot `index`, keeping it strictly between its neighbours in x. */
export function moveCurvePoint(
  points: readonly CurvePoint[],
  index: number,
  x: number,
  y: number,
): CurvePoint[] {
  if (index < 0 || index >= points.length) return points.map((p) => ({ ...p }));
  const lo = index > 0 ? points[index - 1].x + CURVE_MIN_SPACING : 0;
  const hi = index < points.length - 1 ? points[index + 1].x - CURVE_MIN_SPACING : 1;
  return points.map((p, i) =>
    i === index ? { x: clamp(clamp01(x), lo, Math.max(lo, hi)), y: clamp01(y) } : { ...p },
  );
}

/** Remove knot `index`; a curve always keeps at least two knots. */
export function removeCurvePoint(points: readonly CurvePoint[], index: number): CurvePoint[] {
  if (points.length <= 2 || index < 0 || index >= points.length) {
    return points.map((p) => ({ ...p }));
  }
  return points.filter((_, i) => i !== index).map((p) => ({ ...p }));
}

function sampleCurveAt(points: readonly CurvePoint[], x: number): number {
  const slopes = monotoneSlopes(points);
  const packed = new Float32Array(points.length * 4);
  points.forEach((p, i) => {
    packed[i * 4] = p.x;
    packed[i * 4 + 1] = p.y;
    packed[i * 4 + 2] = slopes[i];
  });
  return evalPackedCurve(packed, 0, points.length, x);
}
