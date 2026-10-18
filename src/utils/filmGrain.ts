/**
 * Film-quality grain — the reference implementation of the `film` quality
 * mode in `shaders/grain.wgsl` (`filmGrainRgb`). Pure; the WGSL mirrors it
 * line for line, and the tests here pin its statistics (mean, RMS, spectrum,
 * frame-to-frame correlation) so the two cannot drift silently.
 *
 * Why it looks better than `classic`:
 * - **Integer hash** (PCG4D, Jarzynski & Olano 2020) on (cell, frame, octave)
 *   instead of a float `fract` hash, so large frame seeds do not degrade into
 *   visible patterns and every GPU produces the same bits.
 * - **Blue-noise lattice.** Each lattice value is white noise minus the mean
 *   of its four neighbours (a discrete Laplacian), which removes the
 *   low-frequency mottling white noise has. It is then interpolated with a
 *   quintic fade, so grains are soft and round, not square cells.
 * - **Two octaves** (the second finer, at half weight) give the clumped,
 *   uneven crystal size of real stock.
 * - **Stateless temporal coherence.** The field cross-fades between two
 *   frame-keyed fields with a variance-preserving weight, so grain can evolve
 *   slowly instead of re-rolling every frame — without a previous-frame
 *   texture, so it never smears moving edges and a seek or export lands on
 *   exactly the same grain as playback.
 */

import { clamp, clamp01 } from './math';

/** Classic and film grain share this RMS swing at amount 1 (`0.08 / sqrt(3)`). */
export const FILM_GRAIN_RMS = 0.046;

/**
 * Rescales the two-octave blue lattice noise to unit RMS. Measured over the
 * reference implementation (see `filmGrain.test.ts`); `grain.wgsl` carries the
 * same literal and a test checks they agree.
 */
export const FILM_GRAIN_NORM = 2.0;

/** Frequency multiplier and offset of the second (finer) octave. */
export const FILM_GRAIN_OCTAVE2_SCALE = 2.17;
export const FILM_GRAIN_OCTAVE2_WEIGHT = 0.5;

/** Temporal coherence 1 holds each grain field for this many frames. */
export const FILM_GRAIN_MAX_HOLD_FRAMES = 12;

/** Grain cells across the frame height (size 0 = fine … 1 = coarse), as classic. */
export function grainCellsAcrossHeight(size: number): number {
  return 720 + (160 - 720) * clamp01(size);
}

export interface GrainResponseCurve {
  /** Grain gain in the shadows (luma 0). */
  shadows: number;
  /** Grain gain in the midtones (luma 0.5). */
  midtones: number;
  /** Grain gain in the highlights (luma 1). */
  highlights: number;
}

export const GRAIN_RESPONSE_MAX = 2;

/** Flat response — the film mode default, matching classic weighting. */
export const FLAT_GRAIN_RESPONSE: GrainResponseCurve = {
  shadows: 1,
  midtones: 1,
  highlights: 1,
};

function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Matches WGSL `grainResponse`: two smoothstep segments through 0 / 0.5 / 1. */
export function grainResponseAt(curve: GrainResponseCurve, luma: number): number {
  if (luma < 0.5) {
    return curve.shadows + (curve.midtones - curve.shadows) * smoothstep01(luma / 0.5);
  }
  return (
    curve.midtones +
    (curve.highlights - curve.midtones) * smoothstep01((luma - 0.5) / 0.5)
  );
}

// ---------------------------------------------------------------------------
// Noise — mirrored in grain.wgsl. Lattice coordinates are i32, bitcast to u32.

type U4 = [number, number, number, number];
type V4 = [number, number, number, number];

/** PCG4D. All arithmetic wraps at 32 bits, exactly like WGSL `u32`. */
export function pcg4d(x: number, y: number, z: number, w: number): U4 {
  let a = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  let b = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  let c = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  let d = (Math.imul(w >>> 0, 1664525) + 1013904223) >>> 0;
  a = (a + Math.imul(b, d)) >>> 0;
  b = (b + Math.imul(c, a)) >>> 0;
  c = (c + Math.imul(a, b)) >>> 0;
  d = (d + Math.imul(b, c)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  b = (b ^ (b >>> 16)) >>> 0;
  c = (c ^ (c >>> 16)) >>> 0;
  d = (d ^ (d >>> 16)) >>> 0;
  a = (a + Math.imul(b, d)) >>> 0;
  b = (b + Math.imul(c, a)) >>> 0;
  c = (c + Math.imul(a, b)) >>> 0;
  d = (d + Math.imul(b, c)) >>> 0;
  return [a, b, c, d];
}

const INV_U32 = 1 / 4294967296;

/** White lattice value in [-1, 1) per channel: (mono, r, g, b). */
function lattice(ix: number, iy: number, frame: number, octave: number): V4 {
  const h = pcg4d(ix, iy, frame, octave);
  return [
    h[0] * INV_U32 * 2 - 1,
    h[1] * INV_U32 * 2 - 1,
    h[2] * INV_U32 * 2 - 1,
    h[3] * INV_U32 * 2 - 1,
  ];
}

/** Blue lattice value: white minus the mean of its 4-neighbourhood (zero DC). */
export function blueLattice(ix: number, iy: number, frame: number, octave: number): V4 {
  const c = lattice(ix, iy, frame, octave);
  const l = lattice(ix - 1, iy, frame, octave);
  const r = lattice(ix + 1, iy, frame, octave);
  const d = lattice(ix, iy - 1, frame, octave);
  const u = lattice(ix, iy + 1, frame, octave);
  return [0, 1, 2, 3].map((k) => c[k] - 0.25 * (l[k] + r[k] + d[k] + u[k])) as V4;
}

function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** One octave: quintic-interpolated blue lattice at `p` (lattice units). */
export function blueValueNoise(px: number, py: number, frame: number, octave: number): V4 {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = quintic(px - ix);
  const fy = quintic(py - iy);
  const b00 = blueLattice(ix, iy, frame, octave);
  const b10 = blueLattice(ix + 1, iy, frame, octave);
  const b01 = blueLattice(ix, iy + 1, frame, octave);
  const b11 = blueLattice(ix + 1, iy + 1, frame, octave);
  return [0, 1, 2, 3].map((k) => {
    const x0 = b00[k] + (b10[k] - b00[k]) * fx;
    const x1 = b01[k] + (b11[k] - b01[k]) * fx;
    return x0 + (x1 - x0) * fy;
  }) as V4;
}

/** Two-octave field for one integer frame key, unit RMS per channel. */
export function filmGrainField(px: number, py: number, frame: number): V4 {
  const o1 = blueValueNoise(px, py, frame, 0);
  const o2 = blueValueNoise(
    px * FILM_GRAIN_OCTAVE2_SCALE + 17.3,
    py * FILM_GRAIN_OCTAVE2_SCALE + 5.9,
    frame,
    1,
  );
  return [0, 1, 2, 3].map(
    (k) => (o1[k] + o2[k] * FILM_GRAIN_OCTAVE2_WEIGHT) * FILM_GRAIN_NORM,
  ) as V4;
}

/** Frames each grain field is held for at a given coherence (1 … MAX_HOLD). */
export function grainHoldFrames(temporalCoherence: number): number {
  return 1 + clamp01(temporalCoherence) * (FILM_GRAIN_MAX_HOLD_FRAMES - 1);
}

/**
 * Temporal key + blend for `frameSeed`. Coherence 0 → a fresh field each frame
 * (`weight` is always 0). The blend is variance-preserving, so grain strength
 * does not pulse between keys.
 */
export function grainTemporalBlend(
  frameSeed: number,
  temporalCoherence: number,
): { key: number; weight: number; norm: number } {
  const hold = grainHoldFrames(temporalCoherence);
  const t = Math.max(0, Math.floor(frameSeed)) / hold;
  const key = Math.floor(t);
  const weight = t - key;
  const norm = 1 / Math.sqrt((1 - weight) * (1 - weight) + weight * weight);
  return { key, weight, norm };
}

/**
 * Film grain RGB offset (unit RMS before amount / response) at a frame UV.
 * `aspect` is width / height, so grains stay round on any frame shape; grain
 * size is relative to the frame height, so preview and export at different
 * resolutions show the same grain.
 */
export function filmGrainRgb(
  u: number,
  v: number,
  aspect: number,
  size: number,
  monochromeBias: number,
  frameSeed: number,
  temporalCoherence: number,
): [number, number, number] {
  const cells = grainCellsAcrossHeight(size);
  const px = u * aspect * cells;
  const py = v * cells;
  const { key, weight, norm } = grainTemporalBlend(frameSeed, temporalCoherence);
  let g = filmGrainField(px, py, key);
  if (weight > 0) {
    const next = filmGrainField(px, py, key + 1);
    g = [0, 1, 2, 3].map((k) => (g[k] * (1 - weight) + next[k] * weight) * norm) as V4;
  }
  const b = clamp01(monochromeBias);
  const monoNorm = 1 / Math.sqrt((1 - b) * (1 - b) + b * b);
  return [
    (g[1] * (1 - b) + g[0] * b) * monoNorm,
    (g[2] * (1 - b) + g[0] * b) * monoNorm,
    (g[3] * (1 - b) + g[0] * b) * monoNorm,
  ];
}

// ---------------------------------------------------------------------------
// Film-stock presets — data only; the shader just reads the uniforms they set.

export type GrainFilmStockId = '35mm-fine' | '35mm' | '16mm' | 'super8' | 'bw';

export interface GrainFilmStock {
  id: GrainFilmStockId;
  label: string;
  description: string;
  amount: number;
  size: number;
  softness: number;
  /** 0 = fully colour (per-channel) grain, 1 = monochrome. */
  monochromeBias: number;
  response: GrainResponseCurve;
}

export const GRAIN_FILM_STOCKS: readonly GrainFilmStock[] = [
  {
    id: '35mm-fine',
    label: '35mm fine',
    description: 'Slow 35mm stock: tight, mostly monochrome grain that fades out of the highlights.',
    amount: 0.22,
    size: 0.2,
    softness: 0.5,
    monochromeBias: 0.85,
    response: { shadows: 0.75, midtones: 1, highlights: 0.5 },
  },
  {
    id: '35mm',
    label: '35mm',
    description: 'Everyday 35mm negative: moderate grain, a little colour in the shadows.',
    amount: 0.32,
    size: 0.4,
    softness: 0.45,
    monochromeBias: 0.75,
    response: { shadows: 0.9, midtones: 1, highlights: 0.6 },
  },
  {
    id: '16mm',
    label: '16mm',
    description: 'Coarser, livelier 16mm grain with visible colour clumps in the shadows.',
    amount: 0.5,
    size: 0.68,
    softness: 0.35,
    monochromeBias: 0.6,
    response: { shadows: 1.15, midtones: 1, highlights: 0.5 },
  },
  {
    id: 'super8',
    label: 'Super 8',
    description: 'Very coarse, colourful grain that is heaviest in the shadows.',
    amount: 0.7,
    size: 0.92,
    softness: 0.25,
    monochromeBias: 0.45,
    response: { shadows: 1.3, midtones: 1, highlights: 0.45 },
  },
  {
    id: 'bw',
    label: 'B&W',
    description: 'Black-and-white stock: monochrome grain that stays present into the highlights.',
    amount: 0.4,
    size: 0.5,
    softness: 0.3,
    monochromeBias: 1,
    response: { shadows: 0.9, midtones: 1, highlights: 0.8 },
  },
];

export function getGrainFilmStock(id: string): GrainFilmStock | undefined {
  return GRAIN_FILM_STOCKS.find((stock) => stock.id === id);
}

export function normalizeGrainResponse(
  raw: Partial<GrainResponseCurve> | undefined,
  defaults: GrainResponseCurve = FLAT_GRAIN_RESPONSE,
): GrainResponseCurve {
  const pick = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, GRAIN_RESPONSE_MAX) : d;
  return {
    shadows: pick(raw?.shadows, defaults.shadows),
    midtones: pick(raw?.midtones, defaults.midtones),
    highlights: pick(raw?.highlights, defaults.highlights),
  };
}
