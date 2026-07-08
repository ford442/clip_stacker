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
    params: [
      { key: 'speed', label: 'Speed', min: 0, max: 6, step: 0.1, default: 1.0 },
      { key: 'angle', label: 'Angle', min: -3.14, max: 3.14, step: 0.05, default: 0.6 },
    ],
  },
  {
    id: 'plasma',
    label: 'Plasma',
    defaults: { scale: 6.0, speed: 1.2 },
    params: [
      { key: 'scale', label: 'Scale', min: 1, max: 24, step: 0.5, default: 6.0 },
      { key: 'speed', label: 'Speed', min: 0, max: 6, step: 0.1, default: 1.2 },
    ],
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
