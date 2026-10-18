/**
 * Sharpening / detail enhancement — late finishing pass after LUT, before grain.
 *
 * Restores edge definition after denoise without a harsh "video" look.
 * WebGPU is WYSIWYG; FFmpeg WASM uses unsharp (luma only). Canvas2D is out of scope.
 */

import { clamp, clamp01, finiteOr } from './math';
import { SHARPEN_MODE_SLOT } from './sharpenReference';

export const SHARPEN_UNIFORM_FLOATS = 8;

/** Soft-cap hint in UI — amounts above this tend to look digital. */
export const SHARPEN_AMOUNT_SOFT_CAP = 0.3;

/** Recommended default amount when enabling the pass. */
export const SHARPEN_AMOUNT_RECOMMENDED = 0.15;

export const SHARPEN_RADIUS_MIN = 0.5;
export const SHARPEN_RADIUS_MAX = 3;

/**
 * `classic` (and an omitted field — old projects) is the original unsharp
 * mask; `edge` is the edge-aware unsharp (range-weighted blur, overshoot
 * clamp, soft threshold); `multiscale` adds a medium detail band for
 * micro-contrast. See `sharpenReference.ts`.
 */
export type SharpenMode = 'classic' | 'edge' | 'multiscale';

export const SHARPEN_MODE_CODE: Record<SharpenMode, number> = {
  classic: 0,
  edge: 1,
  multiscale: 2,
};

export const SHARPEN_MODE_OPTIONS: { id: SharpenMode; label: string; description: string }[] = [
  {
    id: 'classic',
    label: 'Classic unsharp',
    description: 'The original unsharp mask (can halo on high-contrast edges).',
  },
  {
    id: 'edge',
    label: 'Edge-aware',
    description:
      'Unsharp that leaves strong edges alone and clamps overshoot — little to no haloing, gentler on noise.',
  },
  {
    id: 'multiscale',
    label: 'Multi-scale detail',
    description:
      'Edge-aware fine detail plus a wider micro-contrast band; Midtone detail drives the wider band.',
  },
];

export function isSharpenMode(v: unknown): v is SharpenMode {
  return v === 'classic' || v === 'edge' || v === 'multiscale';
}

export interface SharpenSettings {
  enabled: boolean;
  /** Unsharp strength 0 (bypass) → 1. Soft-cap warning above 0.3. */
  amount?: number;
  /** Unsharp blur radius in pixels (0.5 … 3). */
  radius: number;
  /** Luma threshold — skip sharpening when |detail| is below this. */
  threshold: number;
  /** Optional midtone local-contrast boost 0 … 1 (separate from edge unsharp). */
  midtoneDetail: number;
  /** Sharpening model; omitted = `classic`. */
  mode?: SharpenMode;
}

export const DEFAULT_SHARPEN_PARAMS = {
  radius: 1,
  threshold: 0.02,
  midtoneDetail: 0,
};

/** True when sharpen amount and midtone detail are effectively off. */
export function isSharpenNeutral(pass: SharpenSettings | undefined): boolean {
  if (!pass) return true;
  const amount = finiteOr(pass.amount, 0);
  const midtone = finiteOr(pass.midtoneDetail, DEFAULT_SHARPEN_PARAMS.midtoneDetail);
  return amount <= 1e-6 && midtone <= 1e-6;
}

/**
 * Pack SharpenSettings into a Float32Array matching WGSL SharpenUniforms.
 *
 * Layout (2 × vec4):
 *   [0] amount, radius, threshold, midtoneDetail
 *   [1] texelSize.x, texelSize.y, mode (0 classic / 1 edge / 2 multiscale), pad
 */
export function packSharpenUniforms(
  pass: SharpenSettings,
  texelWidth: number,
  texelHeight: number,
  out: Float32Array = new Float32Array(SHARPEN_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < SHARPEN_UNIFORM_FLOATS) {
    throw new Error(`Sharpen uniform buffer needs ${SHARPEN_UNIFORM_FLOATS} floats`);
  }
  const d = DEFAULT_SHARPEN_PARAMS;
  const amount = pass.enabled ? clamp01(pass.amount ?? 0) : 0;
  const midtone = pass.enabled
    ? clamp01(finiteOr(pass.midtoneDetail, d.midtoneDetail))
    : 0;

  out[0] = amount;
  out[1] = clamp(finiteOr(pass.radius, d.radius), SHARPEN_RADIUS_MIN, SHARPEN_RADIUS_MAX);
  out[2] = clamp01(finiteOr(pass.threshold, d.threshold));
  out[3] = midtone;

  out[4] = texelWidth > 0 ? 1 / texelWidth : 0;
  out[5] = texelHeight > 0 ? 1 / texelHeight : 0;
  out[SHARPEN_MODE_SLOT] = isSharpenMode(pass.mode) ? SHARPEN_MODE_CODE[pass.mode] : 0;
  out[7] = 0;

  return out;
}

/** Normalize raw / partial sharpen fields onto defaults. */
export function normalizeSharpenPass(
  raw: Partial<SharpenSettings> | undefined,
  defaults: SharpenSettings,
): SharpenSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...defaults };
  }
  const d = DEFAULT_SHARPEN_PARAMS;
  const enabled = Boolean(raw.enabled);
  const amount = Number.isFinite(raw.amount)
    ? clamp01(raw.amount as number)
    : (defaults.amount ?? SHARPEN_AMOUNT_RECOMMENDED);
  return {
    enabled,
    amount,
    radius: clamp(
      finiteOr(raw.radius, defaults.radius ?? d.radius),
      SHARPEN_RADIUS_MIN,
      SHARPEN_RADIUS_MAX,
    ),
    threshold: clamp01(finiteOr(raw.threshold, defaults.threshold ?? d.threshold)),
    midtoneDetail: clamp01(
      finiteOr(raw.midtoneDetail, defaults.midtoneDetail ?? d.midtoneDetail),
    ),
    // Only carried when set, so an old project round-trips without new keys.
    ...(isSharpenMode(raw.mode)
      ? { mode: raw.mode }
      : isSharpenMode(defaults.mode)
        ? { mode: defaults.mode }
        : {}),
  };
}

/**
 * Map radius (px) → odd unsharp matrix size (3 … 13).
 * FFmpeg unsharp requires odd integer msize in [3, 23].
 */
export function sharpenRadiusToMsize(radius: number): number {
  const r = clamp(finiteOr(radius, DEFAULT_SHARPEN_PARAMS.radius), SHARPEN_RADIUS_MIN, SHARPEN_RADIUS_MAX);
  const odd = Math.round(r) * 2 + 1;
  return clamp(odd % 2 === 0 ? odd + 1 : odd, 3, 13);
}

/**
 * Build FFmpeg unsharp (+ optional mild eq for midtone detail).
 *
 * Available in bundled @ffmpeg/core WASM: unsharp, eq.
 * Luma-only sharpening (chroma_amount=0) to avoid color fringing.
 */
export function buildSharpenFfmpegFilters(pass: SharpenSettings | undefined): string {
  if (!pass?.enabled) return '';
  const amount = clamp01(pass.amount ?? 0);
  const d = DEFAULT_SHARPEN_PARAMS;
  const midtone = clamp01(finiteOr(pass.midtoneDetail, d.midtoneDetail));
  if (amount <= 0 && midtone <= 0) return '';
  if (isSharpenNeutral(pass)) return '';

  const parts: string[] = [];
  const msize = sharpenRadiusToMsize(pass.radius);
  // Map 0…1 UI amount → gentle FFmpeg luma_amount (typical useful range ~0…2.5).
  const lumaAmount = Number((amount * 2.5).toFixed(4));
  if (lumaAmount > 1e-4) {
    parts.push(
      `unsharp=luma_msize_x=${msize}:luma_msize_y=${msize}:luma_amount=${lumaAmount}:chroma_amount=0`,
    );
  }

  // Best-effort midtone local contrast — mild eq contrast (no true midtone mask in FFmpeg).
  if (midtone > 1e-4) {
    const contrast = Number((1 + midtone * 0.12).toFixed(4));
    parts.push(`eq=contrast=${contrast}`);
  }

  return parts.join(',');
}

/**
 * Append sharpen filters onto a filter_complex ending at `[vout]`,
 * renaming the sink to `[vpresharp]` then chaining back to `[vout]`.
 *
 * Expected order: after noise / primary / LUT, before grain.
 */
export function appendSharpenFilters(
  filterComplex: string,
  pass: SharpenSettings | undefined,
): string {
  const chain = buildSharpenFfmpegFilters(pass);
  if (!chain) return filterComplex;
  const rewritten = filterComplex.replace(/\[vout\]/g, '[vpresharp]');
  return `${rewritten};[vpresharp]${chain}[vout]`;
}
