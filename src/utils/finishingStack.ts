/**
 * The Effects Stack's model: the eight finishing passes as a flat list that can
 * be toggled, scaled and A/B-compared without opening the detailed panels.
 *
 * Everything here is pure over `FinishingSettings`. Enabling and amount edits
 * change the project's settings (they round-trip and export); the *view*
 * (bypass all / "show before" per pass) is preview-only and lives in `uiStore`,
 * so it never reaches a saved project or an export.
 */

import {
  DEFAULT_CHROMATIC_ABERRATION,
  DEFAULT_CURVES,
  DEFAULT_GRAIN,
  DEFAULT_LUT_PASS,
  DEFAULT_NOISE_REDUCTION,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  DEFAULT_SHARPEN,
  isChromaticAberrationActive,
  isCurvesActive,
  isGrainActive,
  isLutFinishingPassActive,
  isNoiseReductionActive,
  isPrimaryColorActive,
  isSecondaryColorActive,
  isSharpenActive,
  type FinishingSettings,
} from './finishing';

export type FinishingPassKey = keyof FinishingSettings;

export interface FinishingStackPass {
  key: FinishingPassKey;
  label: string;
  /** Short label for the compact chip strip. */
  chip: string;
}

/** Chain order: noise → primary → curves → secondary → LUT → sharpen → CA → grain. */
export const FINISHING_STACK_PASSES: readonly FinishingStackPass[] = [
  { key: 'noiseReduction', label: 'Noise reduction', chip: 'Noise' },
  { key: 'primaryColor', label: 'Primary color', chip: 'Primary' },
  { key: 'curves', label: 'Curves & levels', chip: 'Curves' },
  { key: 'secondaryColor', label: 'Secondary color', chip: 'Secondary' },
  { key: 'lut', label: 'Creative LUT', chip: 'LUT' },
  { key: 'sharpen', label: 'Sharpen', chip: 'Sharpen' },
  { key: 'chromaticAberration', label: 'Chromatic aberration', chip: 'CA' },
  { key: 'grain', label: 'Grain & optical', chip: 'Grain' },
];

function defaultPass(key: FinishingPassKey): NonNullable<FinishingSettings[FinishingPassKey]> {
  switch (key) {
    case 'noiseReduction':
      return { ...DEFAULT_NOISE_REDUCTION };
    case 'primaryColor':
      return { ...DEFAULT_PRIMARY_COLOR };
    case 'curves':
      return {
        ...DEFAULT_CURVES,
        levels: { ...DEFAULT_CURVES.levels },
        curves: {
          master: [...DEFAULT_CURVES.curves.master],
          red: [...DEFAULT_CURVES.curves.red],
          green: [...DEFAULT_CURVES.curves.green],
          blue: [...DEFAULT_CURVES.curves.blue],
        },
      };
    case 'secondaryColor':
      return { ...DEFAULT_SECONDARY_COLOR, grades: [] };
    case 'lut':
      return { ...DEFAULT_LUT_PASS };
    case 'sharpen':
      return { ...DEFAULT_SHARPEN };
    case 'chromaticAberration':
      return { ...DEFAULT_CHROMATIC_ABERRATION };
    case 'grain':
      return {
        ...DEFAULT_GRAIN,
        vignette: { ...DEFAULT_GRAIN.vignette },
        halation: { ...DEFAULT_GRAIN.halation },
      };
  }
}

function slot(settings: FinishingSettings, key: FinishingPassKey) {
  return settings[key] ?? defaultPass(key);
}

export function isPassEnabled(settings: FinishingSettings, key: FinishingPassKey): boolean {
  return settings[key]?.enabled === true;
}

/**
 * Enabled and actually changing pixels. An enabled pass can still be a no-op
 * (a LUT slot with no LUT, secondary with no grades, zero strength) — the
 * stack flags that rather than letting a toggle look broken.
 */
export function isPassContributing(settings: FinishingSettings, key: FinishingPassKey): boolean {
  switch (key) {
    case 'noiseReduction':
      return isNoiseReductionActive(settings.noiseReduction);
    case 'primaryColor':
      return isPrimaryColorActive(settings.primaryColor);
    case 'curves':
      return isCurvesActive(settings.curves);
    case 'secondaryColor':
      return isSecondaryColorActive(settings.secondaryColor);
    case 'lut':
      return isLutFinishingPassActive(settings.lut);
    case 'sharpen':
      return isSharpenActive(settings.sharpen);
    case 'chromaticAberration':
      return isChromaticAberrationActive(settings.chromaticAberration);
    case 'grain':
      return isGrainActive(settings.grain);
  }
}

/** A fresh settings object with one pass switched on or off (other passes shared). */
export function setPassEnabled(
  settings: FinishingSettings,
  key: FinishingPassKey,
  enabled: boolean,
): FinishingSettings {
  return { ...settings, [key]: { ...slot(settings, key), enabled } };
}

/** Passes that have a 0–1 strength control (the LUT's is its `intensity`). */
export function passAmount(settings: FinishingSettings, key: FinishingPassKey): number {
  if (key === 'lut') {
    const intensity = settings.lut?.intensity;
    return typeof intensity === 'number' && Number.isFinite(intensity) ? clamp01(intensity) : 1;
  }
  const amount = (settings[key] as { amount?: number } | undefined)?.amount;
  return typeof amount === 'number' && Number.isFinite(amount) ? clamp01(amount) : 1;
}

export function setPassAmount(
  settings: FinishingSettings,
  key: FinishingPassKey,
  amount: number,
): FinishingSettings {
  const value = clamp01(Number.isFinite(amount) ? amount : 0);
  const pass = slot(settings, key);
  return {
    ...settings,
    [key]: key === 'lut' ? { ...pass, intensity: value } : { ...pass, amount: value },
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Preview-only audition state; never serialized, never exported. */
export interface FinishingPreviewView {
  /** Show the raw composite: the whole chain is skipped, settings untouched. */
  bypassAll: boolean;
  /** Passes shown "before": skipped in the preview while the rest still apply. */
  before: readonly FinishingPassKey[];
}

export const DEFAULT_FINISHING_PREVIEW_VIEW: FinishingPreviewView = {
  bypassAll: false,
  before: [],
};

export function isFinishingViewActive(view: FinishingPreviewView): boolean {
  return view.bypassAll || view.before.length > 0;
}

/**
 * The settings the preview should draw. Returns `settings` itself when the
 * view changes nothing (so memoised consumers don't see a new object), and
 * `undefined` for a full bypass.
 */
export function applyFinishingPreviewView(
  settings: FinishingSettings | undefined,
  view: FinishingPreviewView,
): FinishingSettings | undefined {
  if (!settings) return settings;
  if (view.bypassAll) return undefined;
  const hidden = view.before.filter((key) => settings[key]?.enabled === true);
  if (hidden.length === 0) return settings;
  const next: FinishingSettings = { ...settings };
  for (const key of hidden) {
    next[key] = { ...settings[key]!, enabled: false } as never;
  }
  return next;
}

/** Toggle one pass in the "before" list. */
export function toggleBefore(
  view: FinishingPreviewView,
  key: FinishingPassKey,
): FinishingPreviewView {
  const before = view.before.includes(key)
    ? view.before.filter((k) => k !== key)
    : [...view.before, key];
  return { ...view, before };
}
