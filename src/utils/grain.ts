/**
 * Film grain + optical emulation — final finishing pass (after sharpen / LUT).
 *
 * Procedural grain uses an integer frame seed for WYSIWYG preview ↔ export.
 * Optional vignette, halation (red-channel bloom), and soft highlight bloom.
 * WebGPU is authoritative; FFmpeg WASM is best-effort. Canvas2D does not apply
 * finishing (grain would not match WebGPU — documented gap).
 */

import { TIMELINE_EXPORT_FPS } from './webcodecs-timeline';

export const GRAIN_UNIFORM_FLOATS = 16;

/** Recommended grain amount when enabling the pass. */
export const GRAIN_AMOUNT_RECOMMENDED = 0.35;

export const GRAIN_SIZE_MIN = 0;
export const GRAIN_SIZE_MAX = 1;

export interface GrainVignetteSettings {
  enabled: boolean;
  /** Falloff strength 0 … 1. */
  amount: number;
  /** Radius where falloff begins (0 center … 1 edges). */
  midpoint: number;
  /** Shape: 0 = more circular, 1 = more rectangular / softer corners. */
  roundness: number;
}

export interface GrainHalationSettings {
  enabled: boolean;
  /** Brightness threshold for red bloom 0 … 1. */
  threshold: number;
  /** Halation mix strength 0 … 1. */
  amount: number;
  /** Blur radius in pixels (approx). */
  radius: number;
}

export interface GrainSettings {
  enabled: boolean;
  /** Grain strength 0 (bypass grain) → 1. */
  amount?: number;
  /** Coarse (1) vs fine (0) grain scale. */
  size: number;
  /** Bias grain toward midtones (1) vs full tonal range (0). */
  softness: number;
  /** Monochrome grain (default on). */
  monochrome: boolean;
  vignette: GrainVignetteSettings;
  halation: GrainHalationSettings;
  /** Soft highlight bloom 0 … 1 (shares blur with halation). */
  bloomAmount: number;
}

export const DEFAULT_GRAIN_VIGNETTE: GrainVignetteSettings = {
  enabled: false,
  amount: 0.35,
  midpoint: 0.55,
  roundness: 0.35,
};

export const DEFAULT_GRAIN_HALATION: GrainHalationSettings = {
  enabled: false,
  threshold: 0.72,
  amount: 0.25,
  radius: 8,
};

export const DEFAULT_GRAIN_PARAMS = {
  size: 0.45,
  softness: 0.55,
  monochrome: true,
  bloomAmount: 0,
  vignette: { ...DEFAULT_GRAIN_VIGNETTE },
  halation: { ...DEFAULT_GRAIN_HALATION },
};

export type GrainPresetId = '16mm' | '35mm' | 'subtle-clean';

export interface GrainPreset {
  id: GrainPresetId;
  label: string;
  settings: Omit<GrainSettings, 'enabled'>;
}

/** Named looks for the Film grain & optical panel. */
export const GRAIN_PRESETS: GrainPreset[] = [
  {
    id: '16mm',
    label: '16mm',
    settings: {
      amount: 0.55,
      size: 0.75,
      softness: 0.45,
      monochrome: true,
      bloomAmount: 0.12,
      vignette: { enabled: true, amount: 0.4, midpoint: 0.5, roundness: 0.3 },
      halation: { enabled: true, threshold: 0.68, amount: 0.22, radius: 10 },
    },
  },
  {
    id: '35mm',
    label: '35mm',
    settings: {
      amount: 0.32,
      size: 0.4,
      softness: 0.6,
      monochrome: true,
      bloomAmount: 0.06,
      vignette: { enabled: true, amount: 0.22, midpoint: 0.58, roundness: 0.4 },
      halation: { enabled: false, threshold: 0.75, amount: 0.18, radius: 7 },
    },
  },
  {
    id: 'subtle-clean',
    label: 'Subtle clean',
    settings: {
      amount: 0.12,
      size: 0.25,
      softness: 0.7,
      monochrome: true,
      bloomAmount: 0,
      vignette: { enabled: false, amount: 0.2, midpoint: 0.55, roundness: 0.35 },
      halation: { enabled: false, threshold: 0.72, amount: 0.15, radius: 6 },
    },
  },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function cloneVignette(v: GrainVignetteSettings): GrainVignetteSettings {
  return { ...v };
}

function cloneHalation(h: GrainHalationSettings): GrainHalationSettings {
  return { ...h };
}

/** Integer frame index from timeline seconds — stable seed for export / preview. */
export function grainFrameSeedFromTime(
  globalTimeSec: number,
  fps: number = TIMELINE_EXPORT_FPS,
): number {
  if (!Number.isFinite(globalTimeSec) || !Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(globalTimeSec * fps));
}

function normalizeVignette(
  raw: Partial<GrainVignetteSettings> | undefined,
  defaults: GrainVignetteSettings,
): GrainVignetteSettings {
  if (!raw || typeof raw !== 'object') return cloneVignette(defaults);
  return {
    enabled: Boolean(raw.enabled),
    amount: clamp01(finiteOr(raw.amount, defaults.amount)),
    midpoint: clamp01(finiteOr(raw.midpoint, defaults.midpoint)),
    roundness: clamp01(finiteOr(raw.roundness, defaults.roundness)),
  };
}

function normalizeHalation(
  raw: Partial<GrainHalationSettings> | undefined,
  defaults: GrainHalationSettings,
): GrainHalationSettings {
  if (!raw || typeof raw !== 'object') return cloneHalation(defaults);
  return {
    enabled: Boolean(raw.enabled),
    threshold: clamp01(finiteOr(raw.threshold, defaults.threshold)),
    amount: clamp01(finiteOr(raw.amount, defaults.amount)),
    radius: clamp(finiteOr(raw.radius, defaults.radius), 0.5, 32),
  };
}

/** True when grain amount and all optical effects are effectively off. */
export function isGrainNeutral(pass: GrainSettings | undefined): boolean {
  if (!pass) return true;
  const amount = finiteOr(pass.amount, 0);
  const vignetteOn =
    Boolean(pass.vignette?.enabled) && finiteOr(pass.vignette?.amount, 0) > 1e-6;
  const halationOn =
    Boolean(pass.halation?.enabled) && finiteOr(pass.halation?.amount, 0) > 1e-6;
  const bloom = finiteOr(pass.bloomAmount, 0);
  return amount <= 1e-6 && !vignetteOn && !halationOn && bloom <= 1e-6;
}

/**
 * Pack GrainSettings into a Float32Array matching WGSL GrainUniforms.
 *
 * Layout (4 × vec4):
 *   [0] amount, size, softness, monochrome
 *   [1] vignetteAmount, vignetteMidpoint, vignetteRoundness, frameSeed
 *   [2] halationAmount,halationThreshold,halationRadius, bloomAmount
 *   [3] texelSize.x, texelSize.y, pad, pad
 */
export function packGrainUniforms(
  pass: GrainSettings,
  texelWidth: number,
  texelHeight: number,
  frameSeed: number,
  out: Float32Array = new Float32Array(GRAIN_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < GRAIN_UNIFORM_FLOATS) {
    throw new Error(`Grain uniform buffer needs ${GRAIN_UNIFORM_FLOATS} floats`);
  }
  const d = DEFAULT_GRAIN_PARAMS;
  const enabled = Boolean(pass.enabled);
  const amount = enabled ? clamp01(pass.amount ?? 0) : 0;
  const vignette = pass.vignette ?? d.vignette;
  const halation = pass.halation ?? d.halation;

  out[0] = amount;
  out[1] = clamp01(finiteOr(pass.size, d.size));
  out[2] = clamp01(finiteOr(pass.softness, d.softness));
  out[3] = pass.monochrome !== false ? 1 : 0;

  out[4] =
    enabled && vignette.enabled ? clamp01(finiteOr(vignette.amount, 0)) : 0;
  out[5] = clamp01(finiteOr(vignette.midpoint, d.vignette.midpoint));
  out[6] = clamp01(finiteOr(vignette.roundness, d.vignette.roundness));
  out[7] = Number.isFinite(frameSeed) ? Math.max(0, Math.floor(frameSeed)) : 0;

  out[8] =
    enabled && halation.enabled ? clamp01(finiteOr(halation.amount, 0)) : 0;
  out[9] = clamp01(finiteOr(halation.threshold, d.halation.threshold));
  out[10] = clamp(finiteOr(halation.radius, d.halation.radius), 0.5, 32);
  out[11] = enabled ? clamp01(finiteOr(pass.bloomAmount, d.bloomAmount)) : 0;

  out[12] = texelWidth > 0 ? 1 / texelWidth : 0;
  out[13] = texelHeight > 0 ? 1 / texelHeight : 0;
  out[14] = 0;
  out[15] = 0;

  return out;
}

/** Normalize raw / partial grain fields onto defaults. */
export function normalizeGrainPass(
  raw: Partial<GrainSettings> | undefined,
  defaults: GrainSettings,
): GrainSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      ...defaults,
      vignette: cloneVignette(defaults.vignette),
      halation: cloneHalation(defaults.halation),
    };
  }
  const d = DEFAULT_GRAIN_PARAMS;
  const enabled = Boolean(raw.enabled);
  const amount = Number.isFinite(raw.amount)
    ? clamp01(raw.amount as number)
    : (defaults.amount ?? GRAIN_AMOUNT_RECOMMENDED);
  return {
    enabled,
    amount,
    size: clamp01(finiteOr(raw.size, defaults.size ?? d.size)),
    softness: clamp01(finiteOr(raw.softness, defaults.softness ?? d.softness)),
    monochrome:
      typeof raw.monochrome === 'boolean'
        ? raw.monochrome
        : (defaults.monochrome ?? d.monochrome),
    vignette: normalizeVignette(raw.vignette, defaults.vignette ?? d.vignette),
    halation: normalizeHalation(raw.halation, defaults.halation ?? d.halation),
    bloomAmount: clamp01(
      finiteOr(raw.bloomAmount, defaults.bloomAmount ?? d.bloomAmount),
    ),
  };
}

/** Linear FFmpeg filters (noise + vignette) — no labeled pads. */
export function buildGrainLinearFfmpegFilters(
  pass: GrainSettings | undefined,
): string {
  if (!pass?.enabled || isGrainNeutral(pass)) return '';

  const parts: string[] = [];
  const amount = clamp01(pass.amount ?? 0);
  const d = DEFAULT_GRAIN_PARAMS;

  if (amount > 1e-4) {
    // Map 0…1 → noise alls ≈ 0…40 (gentle cinematic range).
    const alls = Number((amount * 40).toFixed(2));
    parts.push(`noise=alls=${alls}:allf=t+u`);
  }

  const vignette = pass.vignette ?? d.vignette;
  if (vignette.enabled && vignette.amount > 1e-4) {
    // FFmpeg vignette angle: smaller → stronger edge darkening.
    const angle = Number(
      (Math.PI / 5 + (1 - vignette.amount) * (Math.PI / 4)).toFixed(4),
    );
    parts.push(`vignette=angle=${angle}:mode=forward`);
  }

  return parts.join(',');
}

/** Best-effort red-biased soft bloom /halation graph body (no outer labels). */
export function buildGrainBloomFfmpegGraph(
  pass: GrainSettings | undefined,
): string {
  if (!pass?.enabled) return '';
  const d = DEFAULT_GRAIN_PARAMS;
  const halation = pass.halation ?? d.halation;
  const bloom = clamp01(finiteOr(pass.bloomAmount, 0));
  const wantsOpticalBloom =
    (halation.enabled && halation.amount > 1e-4) || bloom > 1e-4;
  if (!wantsOpticalBloom) return '';

  const radius = halation.enabled
    ? clamp(finiteOr(halation.radius, d.halation.radius), 0.5, 32)
    : 6;
  const sigma = Number((radius * 0.35).toFixed(3));
  const opacity = Number(
    Math.min(
      1,
      (halation.enabled ? halation.amount : 0) * 0.65 + bloom * 0.45,
    ).toFixed(3),
  );
  return (
    `split[gbase][gbright];` +
    `[gbright]eq=brightness=0.05:saturation=1.2,` +
    `colorchannelmixer=rr=1.15:gg=0.35:bb=0.2,` +
    `gblur=sigma=${sigma}[ghal];` +
    `[gbase][ghal]blend=all_mode=screen:all_opacity=${opacity}`
  );
}

/**
 * Build FFmpeg film-grain linear filters (noise + vignette).
 * Optical bloom is appended separately via `appendGrainFilters`.
 *
 * Available in bundled @ffmpeg/core WASM: noise, vignette, gblur, split, blend.
 * Temporal grain uses `allf=t+u` so the noise field changes per frame.
 */
export function buildGrainFfmpegFilters(pass: GrainSettings | undefined): string {
  return buildGrainLinearFfmpegFilters(pass);
}

/**
 * Append grain / optical filters onto a filter_complex ending at `[vout]`.
 * Must run last in the finishing chain (after sharpen).
 */
export function appendGrainFilters(
  filterComplex: string,
  pass: GrainSettings | undefined,
): string {
  if (!pass?.enabled || isGrainNeutral(pass)) return filterComplex;

  const linear = buildGrainLinearFfmpegFilters(pass);
  const bloomGraph = buildGrainBloomFfmpegGraph(pass);
  if (!linear && !bloomGraph) return filterComplex;

  const result = filterComplex.replace(/\[vout\]/g, '[vpregrain]');

  if (linear && bloomGraph) {
    return (
      `${result};[vpregrain]${linear}[vgrainmid];` +
      `[vgrainmid]${bloomGraph}[vout]`
    );
  }
  if (linear) {
    return `${result};[vpregrain]${linear}[vout]`;
  }
  return `${result};[vpregrain]${bloomGraph}[vout]`;
}

/** Apply a named preset onto an existing grain pass (keeps enabled flag). */
export function applyGrainPreset(
  current: GrainSettings,
  presetId: GrainPresetId,
): GrainSettings {
  const preset = GRAIN_PRESETS.find((p) => p.id === presetId);
  if (!preset) return current;
  return normalizeGrainPass(
    {
      enabled: current.enabled,
      ...preset.settings,
      vignette: { ...preset.settings.vignette },
      halation: { ...preset.settings.halation },
    },
    current,
  );
}
