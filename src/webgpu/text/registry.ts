/**
 * Registry of built-in procedural text fill shaders (WGSL).
 * These are used when a TextOverlay has fill: 'shader'.
 */

import type { TextShaderDef } from './types';

export const TEXT_SHADERS: readonly TextShaderDef[] = [
  {
    id: 'gradient',
    label: 'Animated Gradient',
    defaults: { speed: 1.0, angle: 0.6 },
    defaultColors: { color1: '#3399ff', color2: '#ff4db3' },
    params: [
      { key: 'speed', label: 'Speed', min: 0, max: 6, step: 0.1, default: 1.0 },
      { key: 'angle', label: 'Angle', min: -3.14, max: 3.14, step: 0.05, default: 0.6 },
    ],
    colors: [
      { key: 'color1', label: 'Start color', default: '#3399ff' },
      { key: 'color2', label: 'End color', default: '#ff4db3' },
    ],
    paramSlots: { speed: 0, angle: 1 },
    colorSlots: { color1: 0, color2: 1 },
    mode: 0,
  },
  {
    id: 'plasma',
    label: 'Plasma',
    defaults: { scale: 6.0, speed: 1.2 },
    defaultColors: { color1: '#ff6666', color2: '#66ff99', color3: '#6699ff' },
    params: [
      { key: 'scale', label: 'Scale', min: 1, max: 24, step: 0.5, default: 6.0 },
      { key: 'speed', label: 'Speed', min: 0, max: 6, step: 0.1, default: 1.2 },
    ],
    colors: [
      { key: 'color1', label: 'Color 1', default: '#ff6666' },
      { key: 'color2', label: 'Color 2', default: '#66ff99' },
      { key: 'color3', label: 'Color 3', default: '#6699ff' },
    ],
    paramSlots: { scale: 0, speed: 1 },
    colorSlots: { color1: 0, color2: 1, color3: 2 },
    mode: 1,
  },
] as const;

const BY_ID = new Map(TEXT_SHADERS.map((s) => [s.id, s] as const));

export function getTextShader(id: string | undefined | null): TextShaderDef | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function isKnownTextShader(id: string | undefined | null): boolean {
  return !!getTextShader(id);
}

/** Resolve params for a shader id, merging provided values with shader defaults. */
export function resolveShaderParams(
  shaderId: string | undefined | null,
  provided?: Record<string, number>,
): Record<string, number> {
  const def = getTextShader(shaderId);
  const base = { ...(def?.defaults ?? {}) };
  if (provided) {
    for (const [k, v] of Object.entries(provided)) {
      if (Number.isFinite(v)) base[k] = v;
    }
  }
  return base;
}

/** Resolve color keys for a shader id, merging provided values with defaults. */
export function resolveShaderColors(
  shaderId: string | undefined | null,
  provided?: Record<string, string>,
): Record<string, string> {
  const def = getTextShader(shaderId);
  const base: Record<string, string> = {};
  for (const c of def?.colors ?? []) {
    base[c.key] = c.default;
  }
  if (def?.defaultColors) {
    Object.assign(base, def.defaultColors);
  }
  if (provided) {
    for (const [k, v] of Object.entries(provided)) {
      if (typeof v === 'string' && v.trim()) base[k] = v.trim();
    }
  }
  return base;
}
