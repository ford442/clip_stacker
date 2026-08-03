/**
 * Project-level finishing pass settings — ordered optional passes applied after
 * compositing on the WebGPU preview and GPU export paths.
 *
 * Pass order (professional):
 *   noise reduction → primary color → secondary color → LUT → sharpen → grain
 *
 * Primary color (exposure / WB / lift-gamma-gain), noise reduction
 * (spatial bilateral + optional temporal), and sharpening (unsharp + midtone
 * detail) are implemented on WebGPU with best-effort FFmpeg WASM parity.
 * Canvas2D does not apply finishing.
 */

import {
  COLOR_LUT_NONE,
  DEFAULT_COLOR_GRADE,
  isColorGradeActive,
  type ColorGradeSettings,
} from './lut';
import {
  DEFAULT_PRIMARY_COLOR_PARAMS,
  normalizePrimaryColorPass,
  type PrimaryColorSettings,
} from './primaryColor';
import {
  DEFAULT_NOISE_REDUCTION_PARAMS,
  normalizeNoiseReductionPass,
  type NoiseReductionSettings,
} from './noiseReduction';
import {
  DEFAULT_SHARPEN_PARAMS,
  SHARPEN_AMOUNT_RECOMMENDED,
  normalizeSharpenPass,
  type SharpenSettings,
} from './sharpen';

export type { PrimaryColorSettings } from './primaryColor';
export type { NoiseReductionSettings } from './noiseReduction';
export type { SharpenSettings } from './sharpen';

export interface FinishingPassBase {
  enabled: boolean;
  /** Effect strength 0 (bypass) → 1 (full). Defaults to 1 when enabled. */
  amount?: number;
}

/** Spatial + optional temporal noise reduction — first finishing pass. */
export type NoiseReductionPass = NoiseReductionSettings;

/** Primary color correction / balancing — before creative LUT. */
export type PrimaryColorPass = PrimaryColorSettings;

/** Secondary / selective color correction (WebGPU pass — see effect issue). */
export interface SecondaryColorPass extends FinishingPassBase {}

/** Creative 3D LUT — maps to the existing LutPass / ColorGradeSettings. */
export interface LutFinishingPass extends FinishingPassBase {
  lutId: string;
  intensity: number;
  customCubeText?: string;
  customFileName?: string;
}

/** Sharpening / detail enhancement — after LUT, before grain. */
export type SharpenPass = SharpenSettings;

/** Film grain + optical emulation — applied last (WebGPU pass — see effect issue). */
export interface GrainPass extends FinishingPassBase {}

/**
 * Fixed slots per pass type. Omitted or disabled passes are skipped in the chain.
 * Serialized on `Project.finishing` when any pass is active.
 */
export interface FinishingSettings {
  noiseReduction?: NoiseReductionPass;
  primaryColor?: PrimaryColorPass;
  secondaryColor?: SecondaryColorPass;
  lut?: LutFinishingPass;
  sharpen?: SharpenPass;
  grain?: GrainPass;
}

export const DEFAULT_NOISE_REDUCTION: NoiseReductionPass = {
  enabled: false,
  amount: 1,
  ...DEFAULT_NOISE_REDUCTION_PARAMS,
};

export const DEFAULT_PRIMARY_COLOR: PrimaryColorPass = {
  enabled: false,
  amount: 1,
  ...DEFAULT_PRIMARY_COLOR_PARAMS,
  lift: [...DEFAULT_PRIMARY_COLOR_PARAMS.lift] as [number, number, number],
  gamma: [...DEFAULT_PRIMARY_COLOR_PARAMS.gamma] as [number, number, number],
  gain: [...DEFAULT_PRIMARY_COLOR_PARAMS.gain] as [number, number, number],
};

export const DEFAULT_SECONDARY_COLOR: SecondaryColorPass = {
  enabled: false,
  amount: 1,
};

export const DEFAULT_LUT_PASS: LutFinishingPass = {
  enabled: false,
  lutId: COLOR_LUT_NONE,
  intensity: 1,
};

export const DEFAULT_SHARPEN: SharpenPass = {
  enabled: false,
  amount: SHARPEN_AMOUNT_RECOMMENDED,
  ...DEFAULT_SHARPEN_PARAMS,
};

export const DEFAULT_GRAIN: GrainPass = {
  enabled: false,
  amount: 1,
};

export const DEFAULT_FINISHING: FinishingSettings = {
  noiseReduction: { ...DEFAULT_NOISE_REDUCTION },
  primaryColor: { ...DEFAULT_PRIMARY_COLOR },
  secondaryColor: { ...DEFAULT_SECONDARY_COLOR },
  lut: { ...DEFAULT_LUT_PASS },
  sharpen: { ...DEFAULT_SHARPEN },
  grain: { ...DEFAULT_GRAIN },
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function passAmount(pass: FinishingPassBase | undefined): number {
  if (!pass?.enabled) return 0;
  const amount = pass.amount ?? 1;
  return Number.isFinite(amount) ? clamp01(amount) : 0;
}

export function isNoiseReductionActive(pass: NoiseReductionPass | undefined): boolean {
  if (passAmount(pass) <= 0) return false;
  const spatial = pass?.spatialStrength ?? 0;
  const temporalOn = Boolean(pass?.temporal);
  const temporal = pass?.temporalStrength ?? 0;
  return spatial > 0 || (temporalOn && temporal > 0);
}

export function isPrimaryColorActive(pass: PrimaryColorPass | undefined): boolean {
  return passAmount(pass) > 0;
}

export function isSecondaryColorActive(pass: SecondaryColorPass | undefined): boolean {
  return passAmount(pass) > 0;
}

export function isLutFinishingPassActive(pass: LutFinishingPass | undefined): boolean {
  if (!pass?.enabled) return false;
  if (pass.lutId === COLOR_LUT_NONE) return false;
  const intensity = Number.isFinite(pass.intensity) ? pass.intensity : 0;
  return intensity > 0;
}

export function isSharpenActive(pass: SharpenPass | undefined): boolean {
  if (!pass?.enabled) return false;
  const amount = Number.isFinite(pass.amount) ? clamp01(pass.amount as number) : 0;
  const midtone = Number.isFinite(pass.midtoneDetail) ? clamp01(pass.midtoneDetail) : 0;
  return amount > 0 || midtone > 0;
}

export function isGrainActive(pass: GrainPass | undefined): boolean {
  return passAmount(pass) > 0;
}

/** True when any finishing pass is enabled with a non-zero amount/intensity. */
export function isFinishingActive(settings: FinishingSettings | undefined): boolean {
  if (!settings) return false;
  return (
    isNoiseReductionActive(settings.noiseReduction) ||
    isPrimaryColorActive(settings.primaryColor) ||
    isSecondaryColorActive(settings.secondaryColor) ||
    isLutFinishingPassActive(settings.lut) ||
    isSharpenActive(settings.sharpen) ||
    isGrainActive(settings.grain)
  );
}

/** Convert LUT finishing slot to legacy ColorGradeSettings (for LutPass / pickers). */
export function lutPassToColorGrade(pass: LutFinishingPass | undefined): ColorGradeSettings {
  if (!pass) return { ...DEFAULT_COLOR_GRADE };
  return {
    lutId: pass.lutId ?? COLOR_LUT_NONE,
    intensity: Number.isFinite(pass.intensity)
      ? clamp01(pass.intensity)
      : DEFAULT_COLOR_GRADE.intensity,
    ...(pass.customCubeText ? { customCubeText: pass.customCubeText } : {}),
    ...(pass.customFileName ? { customFileName: pass.customFileName } : {}),
  };
}

/** Build a LUT finishing slot from ColorGradeSettings. */
export function colorGradeToLutPass(
  settings: ColorGradeSettings,
  enabled = isColorGradeActive(settings),
): LutFinishingPass {
  return {
    enabled,
    lutId: settings.lutId,
    intensity: settings.intensity,
    ...(settings.customCubeText ? { customCubeText: settings.customCubeText } : {}),
    ...(settings.customFileName ? { customFileName: settings.customFileName } : {}),
  };
}

/** Effective color grade derived from finishing settings (LUT slot). */
export function getColorGradeFromFinishing(
  settings: FinishingSettings | undefined,
): ColorGradeSettings {
  if (!settings?.lut || !isLutFinishingPassActive(settings.lut)) {
    return { ...DEFAULT_COLOR_GRADE };
  }
  return lutPassToColorGrade(settings.lut);
}

function normalizePassBase<T extends FinishingPassBase>(
  raw: Partial<T> | undefined,
  defaults: T,
): T {
  if (!raw || typeof raw !== 'object') return { ...defaults };
  const enabled = Boolean(raw.enabled);
  const amount = Number.isFinite(raw.amount)
    ? clamp01(raw.amount as number)
    : defaults.amount ?? 1;
  return { ...defaults, ...raw, enabled, amount };
}

function normalizeLutPass(raw: Partial<LutFinishingPass> | undefined): LutFinishingPass {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LUT_PASS };
  const enabled = Boolean(raw.enabled);
  const lutId = typeof raw.lutId === 'string' ? raw.lutId : DEFAULT_LUT_PASS.lutId;
  const intensity = Number.isFinite(raw.intensity)
    ? clamp01(raw.intensity as number)
    : DEFAULT_LUT_PASS.intensity;
  return {
    enabled,
    lutId,
    intensity,
    amount: intensity,
    ...(typeof raw.customCubeText === 'string' ? { customCubeText: raw.customCubeText } : {}),
    ...(typeof raw.customFileName === 'string' ? { customFileName: raw.customFileName } : {}),
  };
}

/** Normalize partial / legacy project data into a full FinishingSettings object. */
export function normalizeFinishingSettings(
  raw: Partial<FinishingSettings> | undefined,
): FinishingSettings {
  return {
    noiseReduction: normalizeNoiseReductionPass(raw?.noiseReduction, DEFAULT_NOISE_REDUCTION),
    primaryColor: normalizePrimaryColorPass(raw?.primaryColor, DEFAULT_PRIMARY_COLOR),
    secondaryColor: normalizePassBase(raw?.secondaryColor, DEFAULT_SECONDARY_COLOR),
    lut: normalizeLutPass(raw?.lut),
    sharpen: normalizeSharpenPass(raw?.sharpen, DEFAULT_SHARPEN),
    grain: normalizePassBase(raw?.grain, DEFAULT_GRAIN),
  };
}

/**
 * Resolve finishing settings from a loaded project, migrating legacy `colorGrade`
 * when `finishing` is absent.
 */
export function resolveFinishingFromProject(project: {
  finishing?: Partial<FinishingSettings>;
  colorGrade?: ColorGradeSettings;
}): FinishingSettings {
  if (project.finishing) {
    const normalized = normalizeFinishingSettings(project.finishing);
    // If finishing exists but LUT is off, still honor legacy colorGrade when present.
    if (!isLutFinishingPassActive(normalized.lut) && isColorGradeActive(project.colorGrade)) {
      normalized.lut = colorGradeToLutPass(project.colorGrade!, true);
    }
    return normalized;
  }

  if (isColorGradeActive(project.colorGrade)) {
    return {
      ...DEFAULT_FINISHING,
      lut: colorGradeToLutPass(project.colorGrade!, true),
    };
  }

  return { ...DEFAULT_FINISHING };
}

/** Merge LUT picker changes into finishing settings. */
export function withLutPass(
  settings: FinishingSettings,
  lut: LutFinishingPass,
): FinishingSettings {
  return { ...settings, lut: normalizeLutPass(lut) };
}

/** Merge ColorGradePicker output into finishing settings. */
export function withColorGrade(
  settings: FinishingSettings,
  colorGrade: ColorGradeSettings,
): FinishingSettings {
  return withLutPass(settings, colorGradeToLutPass(colorGrade, isColorGradeActive(colorGrade)));
}

/** Update a single pass slot by key. */
export function withFinishingPass<K extends keyof FinishingSettings>(
  settings: FinishingSettings,
  key: K,
  pass: FinishingSettings[K],
): FinishingSettings {
  return { ...settings, [key]: pass };
}

/** Resolve finishing settings from timeline render options (supports legacy colorGrade). */
export function resolveTimelineFinishing(options?: {
  finishing?: FinishingSettings;
  colorGrade?: ColorGradeSettings;
}): FinishingSettings | undefined {
  if (options?.finishing && isFinishingActive(options.finishing)) {
    return options.finishing;
  }
  if (options?.colorGrade && isColorGradeActive(options.colorGrade)) {
    return {
      ...DEFAULT_FINISHING,
      lut: colorGradeToLutPass(options.colorGrade, true),
    };
  }
  return undefined;
}
