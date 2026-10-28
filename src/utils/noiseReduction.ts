/**
 * Noise reduction (spatial + optional temporal) — earliest finishing pass so
 * later color corrections do not amplify sensor noise.
 *
 * WebGPU is WYSIWYG; FFmpeg WASM uses hqdn3d (verified in bundled @ffmpeg/core).
 * Canvas2D does not apply noise reduction (WebGPU only).
 */

import { clamp, clamp01, finiteOr } from './math';
import { NR_QUALITY_SLOT } from './denoiseReference';

export const NOISE_REDUCTION_UNIFORM_FLOATS = 16;

/** Max spatial radius (px) in the WGSL bilateral kernel. */
export const NOISE_REDUCTION_MAX_RADIUS = 4;

/**
 * Spatial quality tier. `standard` (and an omitted field — old projects) is
 * the original 5×5 luma bilateral; `high` is a guided bilateral (3×3 sigma-filter guide) with
 * a Tukey edge stop, a 1.5× reach and luma-guided chroma; `nlm` is non-local
 * means patch matching (strongest, slowest). Temporal is the same in all.
 */
export type NoiseReductionQuality = 'standard' | 'high' | 'nlm';

export const NOISE_REDUCTION_QUALITY_CODE: Record<NoiseReductionQuality, number> = {
  standard: 0,
  high: 1,
  nlm: 2,
};

export const NOISE_REDUCTION_QUALITY_OPTIONS: {
  id: NoiseReductionQuality;
  label: string;
  description: string;
}[] = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Fast 5×5 luma bilateral (the original filter).',
  },
  {
    id: 'high',
    label: 'High (edge-aware)',
    description:
      'Guided bilateral with a hard edge stop and wider reach; also cleans chroma when Luma only is off.',
  },
  {
    id: 'nlm',
    label: 'Patch (NL-means)',
    description:
      'Non-local means patch matching: strongest denoise with the least smearing, but the slowest — use Draft NR for scrubbing.',
  },
];

export function isNoiseReductionQuality(v: unknown): v is NoiseReductionQuality {
  return v === 'standard' || v === 'high' || v === 'nlm';
}

export interface NoiseReductionSettings {
  enabled: boolean;
  /** Overall wet/dry mix 0 (bypass) → 1 (full). */
  amount?: number;
  /** Spatial bilateral strength 0 … 1. */
  spatialStrength: number;
  /** Spatial kernel radius in pixels (capped for preview budget). */
  spatialRadius: number;
  /** When true, blend with previous frame (reset on seek). */
  temporal: boolean;
  /** Temporal blend strength 0 … 1. */
  temporalStrength: number;
  /** Luma delta above which temporal blend is skipped (anti-ghost). */
  temporalMotionThreshold: number;
  /** When true, denoise luminance only and preserve source chroma (default). */
  lumaOnly: boolean;
  /**
   * Draft NR — cheaper spatial kernel for preview (smaller radius / sigma).
   * Export should leave this false for full quality.
   */
  draft?: boolean;
  /** Spatial quality tier; omitted = `standard`. */
  quality?: NoiseReductionQuality;
}

export const DEFAULT_NOISE_REDUCTION_PARAMS = {
  spatialStrength: 0.45,
  spatialRadius: 2,
  temporal: false,
  temporalStrength: 0.35,
  temporalMotionThreshold: 0.08,
  lumaOnly: true,
  draft: false,
};

/** True when spatial and temporal strengths are effectively off. */
export function isNoiseReductionNeutral(pass: NoiseReductionSettings | undefined): boolean {
  if (!pass) return true;
  const d = DEFAULT_NOISE_REDUCTION_PARAMS;
  const spatial = finiteOr(pass.spatialStrength, d.spatialStrength);
  const temporalOn = Boolean(pass.temporal);
  const temporal = finiteOr(pass.temporalStrength, d.temporalStrength);
  return spatial <= 1e-6 && (!temporalOn || temporal <= 1e-6);
}

/**
 * Pack NoiseReductionSettings into a Float32Array matching WGSL uniforms.
 *
 * Layout (4 × vec4):
 *   [0] amount, spatialStrength, spatialRadius, temporalStrength
 *   [1] temporalMotionThreshold, lumaOnly, draft, hasPrev
 *   [2] texelSize.x, texelSize.y, quality (0 standard / 1 high / 2 nlm), pad
 *   [3] pad × 4
 */
export function packNoiseReductionUniforms(
  pass: NoiseReductionSettings,
  texelWidth: number,
  texelHeight: number,
  hasPrev: boolean,
  out: Float32Array = new Float32Array(NOISE_REDUCTION_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < NOISE_REDUCTION_UNIFORM_FLOATS) {
    throw new Error(`Noise reduction uniform buffer needs ${NOISE_REDUCTION_UNIFORM_FLOATS} floats`);
  }
  const d = DEFAULT_NOISE_REDUCTION_PARAMS;
  const amount = pass.enabled ? clamp01(pass.amount ?? 1) : 0;
  const draft = Boolean(pass.draft);
  let radius = clamp(finiteOr(pass.spatialRadius, d.spatialRadius), 0, NOISE_REDUCTION_MAX_RADIUS);
  if (draft) radius = Math.min(radius, 2);

  out[0] = amount;
  out[1] = clamp01(finiteOr(pass.spatialStrength, d.spatialStrength));
  out[2] = radius;
  out[3] = pass.temporal
    ? clamp01(finiteOr(pass.temporalStrength, d.temporalStrength))
    : 0;

  out[4] = clamp01(finiteOr(pass.temporalMotionThreshold, d.temporalMotionThreshold));
  out[5] = pass.lumaOnly === false ? 0 : 1;
  out[6] = draft ? 1 : 0;
  out[7] = hasPrev ? 1 : 0;

  out[8] = texelWidth > 0 ? 1 / texelWidth : 0;
  out[9] = texelHeight > 0 ? 1 / texelHeight : 0;
  out[NR_QUALITY_SLOT] = isNoiseReductionQuality(pass.quality)
    ? NOISE_REDUCTION_QUALITY_CODE[pass.quality]
    : 0;
  out[11] = 0;

  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 0;

  return out;
}

/** Normalize raw / partial noise reduction fields onto defaults. */
export function normalizeNoiseReductionPass(
  raw: Partial<NoiseReductionSettings> | undefined,
  defaults: NoiseReductionSettings,
): NoiseReductionSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...defaults };
  }
  const d = DEFAULT_NOISE_REDUCTION_PARAMS;
  const enabled = Boolean(raw.enabled);
  const amount = Number.isFinite(raw.amount)
    ? clamp01(raw.amount as number)
    : (defaults.amount ?? 1);
  return {
    enabled,
    amount,
    spatialStrength: clamp01(finiteOr(raw.spatialStrength, d.spatialStrength)),
    spatialRadius: clamp(
      finiteOr(raw.spatialRadius, d.spatialRadius),
      0,
      NOISE_REDUCTION_MAX_RADIUS,
    ),
    temporal: Boolean(raw.temporal ?? defaults.temporal),
    temporalStrength: clamp01(finiteOr(raw.temporalStrength, d.temporalStrength)),
    temporalMotionThreshold: clamp01(
      finiteOr(raw.temporalMotionThreshold, d.temporalMotionThreshold),
    ),
    lumaOnly: raw.lumaOnly === false ? false : true,
    draft: Boolean(raw.draft ?? defaults.draft),
    // Only carried when set, so an old project round-trips without new keys.
    ...(isNoiseReductionQuality(raw.quality)
      ? { quality: raw.quality }
      : isNoiseReductionQuality(defaults.quality)
        ? { quality: defaults.quality }
        : {}),
  };
}

/**
 * Build FFmpeg hqdn3d filter for noise reduction (best-effort parity).
 *
 * Available in bundled @ffmpeg/core WASM: hqdn3d, atadenoise, nlmeans, …
 * We use hqdn3d (spatial + temporal luma/chroma). Slow on WASM — callers
 * should surface a status warning.
 */
export function buildNoiseReductionFfmpegFilters(
  pass: NoiseReductionSettings | undefined,
): string {
  if (!pass?.enabled) return '';
  const amount = clamp01(pass.amount ?? 1);
  if (amount <= 0) return '';
  if (isNoiseReductionNeutral(pass)) return '';

  const d = DEFAULT_NOISE_REDUCTION_PARAMS;
  const spatial = clamp01(finiteOr(pass.spatialStrength, d.spatialStrength)) * amount;
  const radius = clamp(finiteOr(pass.spatialRadius, d.spatialRadius), 0, NOISE_REDUCTION_MAX_RADIUS);
  const temporalOn = Boolean(pass.temporal);
  const temporal = temporalOn
    ? clamp01(finiteOr(pass.temporalStrength, d.temporalStrength)) * amount
    : 0;
  const lumaOnly = pass.lumaOnly !== false;

  // hqdn3d typical ranges ~0–10; map strength × radius into that band.
  const lumaSpatial = Number((spatial * (2 + radius) * 1.5).toFixed(3));
  const chromaSpatial = lumaOnly ? 0 : Number((lumaSpatial * 0.65).toFixed(3));
  const lumaTmp = Number((temporal * (4 + radius)).toFixed(3));
  const chromaTmp = lumaOnly ? 0 : Number((lumaTmp * 0.65).toFixed(3));

  if (lumaSpatial <= 0 && lumaTmp <= 0) return '';

  return `hqdn3d=luma_spatial=${lumaSpatial}:chroma_spatial=${chromaSpatial}:luma_tmp=${lumaTmp}:chroma_tmp=${chromaTmp}`;
}

/**
 * Whether finishing temporal state should be cleared for a preview time jump.
 * Clears on any backward scrub, or a large discontinuous seek while paused.
 */
export function shouldResetFinishingTemporal(
  lastTime: number | null | undefined,
  globalTime: number,
  playing: boolean,
): boolean {
  if (lastTime == null || !Number.isFinite(lastTime) || !Number.isFinite(globalTime)) {
    return false;
  }
  if (globalTime < lastTime - 1e-4) return true;
  if (!playing && Math.abs(globalTime - lastTime) > 2 / 30) return true;
  return false;
}

/**
 * Append NR filters onto a filter_complex ending at `[vout]`, renaming the
 * sink to `[vprenoise]` then chaining back to `[vout]`.
 */
export function appendNoiseReductionFilters(
  filterComplex: string,
  pass: NoiseReductionSettings | undefined,
): string {
  const chain = buildNoiseReductionFfmpegFilters(pass);
  if (!chain) return filterComplex;
  const rewritten = filterComplex.replace(/\[vout\]/g, '[vprenoise]');
  return `${rewritten};[vprenoise]${chain}[vout]`;
}
