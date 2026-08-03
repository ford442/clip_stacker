/**
 * Primary color correction / balancing — exposure, contrast, WB, lift/gamma/gain.
 * Applied as a finishing pass before the creative 3D LUT.
 *
 * WebGPU is the WYSIWYG path; FFmpeg WASM uses best-effort filter equivalents.
 * Canvas2D preview does not apply primary color (WebGPU only).
 */

export const PRIMARY_CONTRAST_PIVOT = 0.18;

/** Uniform float count (6 × vec4) for WGSL PrimaryColorUniforms. */
export const PRIMARY_COLOR_UNIFORM_FLOATS = 24;

/** Correction parameters (plus optional enabled/amount from FinishingPassBase). */
export interface PrimaryColorSettings {
  enabled: boolean;
  /** Effect strength 0 (bypass) → 1 (full). Defaults to 1 when enabled. */
  amount?: number;
  /** EV offset, −3 … +3. */
  exposure: number;
  /** Pivot-based contrast multiplier (1 = neutral). */
  contrast: number;
  /** 0 … 2 (1 = neutral). */
  saturation: number;
  /** Correlated color temperature axis, −1 (cool) … +1 (warm). */
  temperature: number;
  /** Green/magenta axis, −1 (magenta) … +1 (green). */
  tint: number;
  /** Shadows offset per channel (DaVinci-style lift). */
  lift: [number, number, number];
  /** Midtone power per channel (1 = neutral). */
  gamma: [number, number, number];
  /** Highlights multiply per channel (1 = neutral). */
  gain: [number, number, number];
}

export const DEFAULT_PRIMARY_COLOR_PARAMS = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  lift: [0, 0, 0] as [number, number, number],
  gamma: [1, 1, 1] as [number, number, number],
  gain: [1, 1, 1] as [number, number, number],
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function normalizeRgbTriplet(
  raw: unknown,
  defaults: [number, number, number],
  lo: number,
  hi: number,
): [number, number, number] {
  if (!Array.isArray(raw) || raw.length < 3) return [...defaults] as [number, number, number];
  return [
    clamp(finiteOr(raw[0], defaults[0]), lo, hi),
    clamp(finiteOr(raw[1], defaults[1]), lo, hi),
    clamp(finiteOr(raw[2], defaults[2]), lo, hi),
  ];
}

/** True when every correction parameter is at its neutral default. */
export function isPrimaryColorNeutral(pass: PrimaryColorSettings | undefined): boolean {
  if (!pass) return true;
  const d = DEFAULT_PRIMARY_COLOR_PARAMS;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const lift = pass.lift ?? d.lift;
  const gamma = pass.gamma ?? d.gamma;
  const gain = pass.gain ?? d.gain;
  return (
    near(pass.exposure ?? d.exposure, d.exposure) &&
    near(pass.contrast ?? d.contrast, d.contrast) &&
    near(pass.saturation ?? d.saturation, d.saturation) &&
    near(pass.temperature ?? d.temperature, d.temperature) &&
    near(pass.tint ?? d.tint, d.tint) &&
    near(lift[0], d.lift[0]) &&
    near(lift[1], d.lift[1]) &&
    near(lift[2], d.lift[2]) &&
    near(gamma[0], d.gamma[0]) &&
    near(gamma[1], d.gamma[1]) &&
    near(gamma[2], d.gamma[2]) &&
    near(gain[0], d.gain[0]) &&
    near(gain[1], d.gain[1]) &&
    near(gain[2], d.gain[2])
  );
}

/**
 * Pack PrimaryColorPass into a Float32Array matching WGSL PrimaryColorUniforms.
 *
 * Layout (6 × vec4):
 *   [0] amount, exposure, contrast, saturation
 *   [1] temperature, tint, contrastPivot, pad
 *   [2] lift.rgb, pad
 *   [3] gamma.rgb, pad
 *   [4] gain.rgb, pad
 *   [5] pad × 4
 */
export function packPrimaryColorUniforms(
  pass: PrimaryColorSettings,
  out: Float32Array = new Float32Array(PRIMARY_COLOR_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < PRIMARY_COLOR_UNIFORM_FLOATS) {
    throw new Error(`Primary color uniform buffer needs ${PRIMARY_COLOR_UNIFORM_FLOATS} floats`);
  }
  const d = DEFAULT_PRIMARY_COLOR_PARAMS;
  const amount = pass.enabled ? clamp01(pass.amount ?? 1) : 0;
  const lift = pass.lift ?? d.lift;
  const gamma = pass.gamma ?? d.gamma;
  const gain = pass.gain ?? d.gain;

  out[0] = amount;
  out[1] = finiteOr(pass.exposure, d.exposure);
  out[2] = finiteOr(pass.contrast, d.contrast);
  out[3] = finiteOr(pass.saturation, d.saturation);

  out[4] = finiteOr(pass.temperature, d.temperature);
  out[5] = finiteOr(pass.tint, d.tint);
  out[6] = PRIMARY_CONTRAST_PIVOT;
  out[7] = 0;

  out[8] = lift[0];
  out[9] = lift[1];
  out[10] = lift[2];
  out[11] = 0;

  out[12] = gamma[0];
  out[13] = gamma[1];
  out[14] = gamma[2];
  out[15] = 0;

  out[16] = gain[0];
  out[17] = gain[1];
  out[18] = gain[2];
  out[19] = 0;

  out[20] = 0;
  out[21] = 0;
  out[22] = 0;
  out[23] = 0;

  return out;
}

/** Normalize raw / partial primary color fields onto defaults. */
export function normalizePrimaryColorPass(
  raw: Partial<PrimaryColorSettings> | undefined,
  defaults: PrimaryColorSettings,
): PrimaryColorSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      ...defaults,
      lift: [...defaults.lift] as [number, number, number],
      gamma: [...defaults.gamma] as [number, number, number],
      gain: [...defaults.gain] as [number, number, number],
    };
  }
  const enabled = Boolean(raw.enabled);
  const amount = Number.isFinite(raw.amount) ? clamp01(raw.amount as number) : (defaults.amount ?? 1);
  const d = DEFAULT_PRIMARY_COLOR_PARAMS;
  return {
    enabled,
    amount,
    exposure: clamp(finiteOr(raw.exposure, d.exposure), -3, 3),
    contrast: clamp(finiteOr(raw.contrast, d.contrast), 0, 2),
    saturation: clamp(finiteOr(raw.saturation, d.saturation), 0, 2),
    temperature: clamp(finiteOr(raw.temperature, d.temperature), -1, 1),
    tint: clamp(finiteOr(raw.tint, d.tint), -1, 1),
    lift: normalizeRgbTriplet(raw.lift, d.lift, -1, 1),
    gamma: normalizeRgbTriplet(raw.gamma, d.gamma, 0.1, 3),
    gain: normalizeRgbTriplet(raw.gain, d.gain, 0, 2),
  };
}

/**
 * Build FFmpeg video filter segments for primary color (best-effort parity).
 *
 * Available in bundled @ffmpeg/core WASM:
 *   - eq (brightness / contrast / saturation / gamma)
 *   - colortemperature
 *   - colorbalance
 *
 * Curves deferred to v1.1. Returns '' when disabled or fully neutral.
 */
export function buildPrimaryColorFfmpegFilters(pass: PrimaryColorSettings | undefined): string {
  if (!pass?.enabled) return '';
  const amount = clamp01(pass.amount ?? 1);
  if (amount <= 0) return '';
  if (isPrimaryColorNeutral(pass)) return '';

  const d = DEFAULT_PRIMARY_COLOR_PARAMS;
  const exposure = finiteOr(pass.exposure, d.exposure) * amount;
  const contrast = 1 + (finiteOr(pass.contrast, d.contrast) - 1) * amount;
  const saturation = 1 + (finiteOr(pass.saturation, d.saturation) - 1) * amount;
  const temperature = finiteOr(pass.temperature, d.temperature) * amount;
  const tint = finiteOr(pass.tint, d.tint) * amount;
  const lift = (pass.lift ?? d.lift).map((v) => v * amount) as [number, number, number];
  const gamma = (pass.gamma ?? d.gamma).map((v) => 1 + (v - 1) * amount) as [
    number,
    number,
    number,
  ];
  const gain = (pass.gain ?? d.gain).map((v) => 1 + (v - 1) * amount) as [
    number,
    number,
    number,
  ];

  const parts: string[] = [];

  // eq: brightness ≈ EV/6 (rough), contrast & saturation direct, gamma from master channel.
  const brightness = clamp(exposure / 6, -1, 1);
  const eqContrast = clamp(contrast, 0, 2);
  const eqSat = clamp(saturation, 0, 3);
  const masterGamma = clamp((gamma[0] + gamma[1] + gamma[2]) / 3, 0.1, 10);
  if (
    Math.abs(brightness) > 1e-4 ||
    Math.abs(eqContrast - 1) > 1e-4 ||
    Math.abs(eqSat - 1) > 1e-4 ||
    Math.abs(masterGamma - 1) > 1e-4
  ) {
    parts.push(
      `eq=brightness=${fmt(brightness)}:contrast=${fmt(eqContrast)}:saturation=${fmt(eqSat)}:gamma=${fmt(masterGamma)}`,
    );
  }

  // colortemperature: map -1..1 → Kelvin around D65 (6500).
  if (Math.abs(temperature) > 1e-4) {
    const kelvin = clamp(6500 - temperature * 2500, 1000, 40000);
    parts.push(`colortemperature=temperature=${fmt(kelvin)}:mix=1`);
  }

  // colorbalance: lift → shadows, tint → midtones green, (gain-1) → highlights.
  const rs = clamp(lift[0], -1, 1);
  const gs = clamp(lift[1], -1, 1);
  const bs = clamp(lift[2], -1, 1);
  const rm = clamp((gain[0] - 1) * 0.5, -1, 1);
  const gm = clamp(tint * 0.35 + (gain[1] - 1) * 0.5, -1, 1);
  const bm = clamp((gain[2] - 1) * 0.5, -1, 1);
  const rh = clamp((gain[0] - 1) * 0.75, -1, 1);
  const gh = clamp((gain[1] - 1) * 0.75, -1, 1);
  const bh = clamp((gain[2] - 1) * 0.75, -1, 1);
  if (
    [rs, gs, bs, rm, gm, bm, rh, gh, bh].some((v) => Math.abs(v) > 1e-4)
  ) {
    parts.push(
      `colorbalance=rs=${fmt(rs)}:gs=${fmt(gs)}:bs=${fmt(bs)}:rm=${fmt(rm)}:gm=${fmt(gm)}:bm=${fmt(bm)}:rh=${fmt(rh)}:gh=${fmt(gh)}:bh=${fmt(bh)}`,
    );
  }

  return parts.join(',');
}

function fmt(n: number): string {
  // Trim trailing zeros for stable golden strings in tests.
  return Number(n.toFixed(6)).toString();
}

/**
 * Append primary-color filters onto a filter_complex that ends at `[vout]`,
 * renaming the sink to `[vpreprimary]` then chaining back to `[vout]`.
 */
export function appendPrimaryColorFilters(
  filterComplex: string,
  pass: PrimaryColorSettings | undefined,
): string {
  const chain = buildPrimaryColorFfmpegFilters(pass);
  if (!chain) return filterComplex;
  const rewritten = filterComplex.replace(/\[vout\]/g, '[vpreprimary]');
  return `${rewritten};[vpreprimary]${chain}[vout]`;
}
