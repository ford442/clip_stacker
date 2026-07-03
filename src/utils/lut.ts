/**
 * 3D LUT utilities — `.cube` parsing, bundled presets, and GPU upload helpers.
 */

export interface LutData {
  /** Edge length of the 3D LUT cube (e.g. 17 → 17³ entries). */
  size: number;
  /** RGB samples in 0–1, length = size³ × 3. Order: B outer, G middle, R inner (Adobe .cube). */
  data: Float32Array;
}

export const COLOR_LUT_NONE = 'none';

export interface ColorGradeSettings {
  /** `'none'`, a bundled preset id, or `'custom'`. */
  lutId: string;
  /** Blend strength 0 (bypass) → 1 (full LUT). */
  intensity: number;
  /** Embedded `.cube` text when `lutId === 'custom'`. */
  customCubeText?: string;
  customFileName?: string;
}

export const DEFAULT_COLOR_GRADE: ColorGradeSettings = {
  lutId: COLOR_LUT_NONE,
  intensity: 1,
};

export interface BundledLutPreset {
  id: string;
  label: string;
  description: string;
}

export const BUNDLED_LUT_PRESETS: BundledLutPreset[] = [
  { id: 'teal-orange', label: 'Teal & Orange', description: 'Blockbuster teal shadows, warm highlights' },
  { id: 'film', label: 'Film', description: 'Soft contrast with lifted blacks' },
  { id: 'bleach', label: 'Bleach Bypass', description: 'Punchy, desaturated contrast' },
  { id: 'warm', label: 'Warm Glow', description: 'Golden-hour warmth' },
];

const PRESET_LUT_SIZE = 17;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Parse an Adobe/IRIDAS `.cube` LUT file into dense RGB samples. */
export function parseCubeLut(text: string): LutData {
  const lines = text.split(/\r?\n/);
  let size = 0;
  const values: number[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) continue;
    if (line.startsWith('DOMAIN_MIN') || line.startsWith('DOMAIN_MAX')) continue;

    const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }

    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) continue;
    values.push(parts[0], parts[1], parts[2]);
  }

  if (size <= 1) {
    throw new Error('Invalid .cube file: missing or invalid LUT_3D_SIZE');
  }

  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new Error(
      `Invalid .cube file: expected ${expected} values, got ${values.length}`,
    );
  }

  return { size, data: new Float32Array(values) };
}

/** Pack LUT RGB floats into RGBA8 for a WebGPU `texture_3d` upload. */
export function lutDataToRgba8(lut: LutData): Uint8Array {
  const count = lut.size ** 3;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const base = i * 3;
    out[i * 4] = Math.round(clamp01(lut.data[base]) * 255);
    out[i * 4 + 1] = Math.round(clamp01(lut.data[base + 1]) * 255);
    out[i * 4 + 2] = Math.round(clamp01(lut.data[base + 2]) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function isColorGradeActive(settings: ColorGradeSettings | undefined): boolean {
  if (!settings) return false;
  if (settings.lutId === COLOR_LUT_NONE) return false;
  return settings.intensity > 0;
}

const presetCache = new Map<string, LutData>();

function buildLut(
  size: number,
  transform: (r: number, g: number, b: number) => [number, number, number],
): LutData {
  const data = new Float32Array(size ** 3 * 3);
  let idx = 0;
  for (let bi = 0; bi < size; bi++) {
    const b = bi / (size - 1);
    for (let gi = 0; gi < size; gi++) {
      const g = gi / (size - 1);
      for (let ri = 0; ri < size; ri++) {
        const r = ri / (size - 1);
        const [or, og, ob] = transform(r, g, b);
        data[idx++] = clamp01(or);
        data[idx++] = clamp01(og);
        data[idx++] = clamp01(ob);
      }
    }
  }
  return { size, data };
}

function createTealOrangeLut(size = PRESET_LUT_SIZE): LutData {
  return buildLut(size, (r, g, b) => {
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const shadow = 1 - lum;
    const highlight = lum;
    return [
      r + 0.12 * highlight - 0.04 * shadow,
      g + 0.06 * shadow - 0.02 * highlight,
      b + 0.18 * shadow - 0.08 * highlight,
    ];
  });
}

function createFilmLut(size = PRESET_LUT_SIZE): LutData {
  return buildLut(size, (r, g, b) => {
    const lift = 0.06;
    const contrast = 0.92;
    const or = (r - 0.5) * contrast + 0.5 + lift;
    const og = (g - 0.5) * contrast + 0.5 + lift;
    const ob = (b - 0.5) * contrast + 0.5 + lift * 0.8;
    const sat = 0.88;
    const lum = 0.2126 * or + 0.7152 * og + 0.0722 * ob;
    return [
      lum + (or - lum) * sat,
      lum + (og - lum) * sat,
      lum + (ob - lum) * sat,
    ];
  });
}

function createBleachBypassLut(size = PRESET_LUT_SIZE): LutData {
  return buildLut(size, (r, g, b) => {
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const contrast = 1.18;
    const mix = 0.35;
    const cr = (r - 0.5) * contrast + 0.5;
    const cg = (g - 0.5) * contrast + 0.5;
    const cb = (b - 0.5) * contrast + 0.5;
    return [
      cr * (1 - mix) + lum * mix,
      cg * (1 - mix) + lum * mix,
      cb * (1 - mix) + lum * mix,
    ];
  });
}

function createWarmGlowLut(size = PRESET_LUT_SIZE): LutData {
  return buildLut(size, (r, g, b) => {
    return [r * 1.05 + 0.04, g * 1.02 + 0.02, b * 0.92];
  });
}

const PRESET_BUILDERS: Record<string, () => LutData> = {
  'teal-orange': createTealOrangeLut,
  film: createFilmLut,
  bleach: createBleachBypassLut,
  warm: createWarmGlowLut,
};

export function createBundledLut(presetId: string): LutData | null {
  const cached = presetCache.get(presetId);
  if (cached) return cached;
  const build = PRESET_BUILDERS[presetId];
  if (!build) return null;
  const lut = build();
  presetCache.set(presetId, lut);
  return lut;
}

/** Resolve LUT data for the current color-grade settings. */
export function resolveLutData(settings: ColorGradeSettings): LutData | null {
  if (settings.lutId === COLOR_LUT_NONE) return null;
  if (settings.lutId === 'custom') {
    if (!settings.customCubeText?.trim()) return null;
    return parseCubeLut(settings.customCubeText);
  }
  return createBundledLut(settings.lutId);
}

/** Upload LUT data to a WebGPU 3D texture (caller owns lifecycle). */
export function uploadLutTexture(
  device: GPUDevice,
  lut: LutData,
  existing: GPUTexture | null = null,
): GPUTexture {
  const rgba = lutDataToRgba8(lut);
  const texture =
    existing &&
    existing.width === lut.size &&
    existing.height === lut.size &&
    existing.depthOrArrayLayers === lut.size
      ? existing
      : device.createTexture({
          size: [lut.size, lut.size, lut.size],
          dimension: '3d',
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow: lut.size * 4, rowsPerImage: lut.size },
    [lut.size, lut.size, lut.size],
  );
  return texture;
}
