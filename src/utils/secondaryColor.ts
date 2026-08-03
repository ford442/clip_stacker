/**
 * Secondary / selective color correction — hue qualifiers + power windows.
 * Applied after primary color, before creative LUT on the WebGPU path.
 *
 * WebGPU is WYSIWYG (preview + GPU export). FFmpeg WASM applies hue-only
 * secondaries via a baked 3D LUT (`lut3d`); window masks are skipped there.
 * Canvas2D does not apply finishing.
 */

import type { LutData } from './lut';

export const MAX_SECONDARY_GRADES = 3;

/** Uniform float count: header (4) + 3 × grade (20) = 64. */
export const SECONDARY_COLOR_UNIFORM_FLOATS = 64;
export const SECONDARY_GRADE_UNIFORM_FLOATS = 20;

export type SecondaryMaskType = 'hue' | 'window' | 'hue+window';

const MASK_TYPES: ReadonlySet<string> = new Set(['hue', 'window', 'hue+window']);

export interface SecondaryGrade {
  enabled: boolean;
  maskType: SecondaryMaskType;
  /** Hue center in degrees, 0 … 360. */
  hueCenter: number;
  /** Qualifier width in degrees. */
  hueWidth: number;
  /** Soft falloff in degrees. */
  hueSoftness: number;
  /** Normalized ellipse center X (0 … 1). */
  windowCenterX: number;
  /** Normalized ellipse center Y (0 … 1). */
  windowCenterY: number;
  /** Normalized ellipse width (0 … 1). */
  windowWidth: number;
  /** Normalized ellipse height (0 … 1). */
  windowHeight: number;
  /** Window rotation in degrees. */
  windowRotation: number;
  /** Soft edge as fraction of ellipse radius (0 … 1). */
  windowFeather: number;
  /** Hue rotate in degrees (−180 … 180). */
  hueShift: number;
  /** Saturation multiply (1 = neutral). */
  satScale: number;
  /** Luminance offset (−1 … 1). */
  lumOffset: number;
  /** Saturation offset (−1 … 1). */
  satOffset: number;
  /** When true, adjust outside the mask instead of inside. */
  invertMask?: boolean;
}

export interface SecondaryColorSettings {
  enabled: boolean;
  /** Effect strength 0 (bypass) → 1 (full). Defaults to 1 when enabled. */
  amount?: number;
  /** Up to {@link MAX_SECONDARY_GRADES} stacked selective grades. */
  grades: SecondaryGrade[];
}

export const DEFAULT_SECONDARY_GRADE: SecondaryGrade = {
  enabled: true,
  maskType: 'hue',
  hueCenter: 210,
  hueWidth: 60,
  hueSoftness: 15,
  windowCenterX: 0.5,
  windowCenterY: 0.5,
  windowWidth: 0.5,
  windowHeight: 0.5,
  windowRotation: 0,
  windowFeather: 0.15,
  hueShift: 0,
  satScale: 1,
  lumOffset: 0,
  satOffset: 0,
  invertMask: false,
};

export const DEFAULT_SECONDARY_COLOR_PARAMS = {
  grades: [] as SecondaryGrade[],
};

export interface SecondaryGradePreset {
  id: string;
  label: string;
  description: string;
  grade: SecondaryGrade;
}

/** Starting qualifier values for common selective grades. */
export const SECONDARY_GRADE_PRESETS: SecondaryGradePreset[] = [
  {
    id: 'sky',
    label: 'Sky',
    description: 'Cyan–blue hue band for skies',
    grade: {
      ...DEFAULT_SECONDARY_GRADE,
      maskType: 'hue',
      hueCenter: 210,
      hueWidth: 70,
      hueSoftness: 18,
      satScale: 0.85,
      hueShift: 8,
    },
  },
  {
    id: 'skin',
    label: 'Skin',
    description: 'Warm orange–peach band for skin tones',
    grade: {
      ...DEFAULT_SECONDARY_GRADE,
      maskType: 'hue',
      hueCenter: 25,
      hueWidth: 45,
      hueSoftness: 12,
      satScale: 1.05,
      lumOffset: 0.02,
    },
  },
  {
    id: 'shadows',
    label: 'Shadows',
    description: 'Soft elliptical window for local exposure',
    grade: {
      ...DEFAULT_SECONDARY_GRADE,
      maskType: 'window',
      windowCenterX: 0.5,
      windowCenterY: 0.55,
      windowWidth: 0.7,
      windowHeight: 0.55,
      windowFeather: 0.35,
      lumOffset: -0.08,
      satScale: 0.92,
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

function wrapHueDegrees(h: number): number {
  const wrapped = h % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Circular hue distance in degrees (0 … 180). */
export function hueDistanceDegrees(a: number, b: number): number {
  const d = Math.abs(wrapHueDegrees(a) - wrapHueDegrees(b));
  return Math.min(d, 360 - d);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

export function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const h = wrapHueDegrees(hDeg) / 360;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

function resolveMaskType(raw: unknown): SecondaryMaskType {
  if (typeof raw === 'string' && MASK_TYPES.has(raw)) {
    return raw as SecondaryMaskType;
  }
  // Unknown / missing → hue (safe default); never throw on load.
  return 'hue';
}

export function normalizeSecondaryGrade(
  raw: Partial<SecondaryGrade> | undefined,
  defaults: SecondaryGrade = DEFAULT_SECONDARY_GRADE,
): SecondaryGrade {
  if (!raw || typeof raw !== 'object') {
    return { ...defaults };
  }
  return {
    enabled: Boolean(raw.enabled ?? defaults.enabled),
    maskType: resolveMaskType(raw.maskType ?? defaults.maskType),
    hueCenter: clamp(finiteOr(raw.hueCenter, defaults.hueCenter), 0, 360),
    hueWidth: clamp(finiteOr(raw.hueWidth, defaults.hueWidth), 0, 360),
    hueSoftness: clamp(finiteOr(raw.hueSoftness, defaults.hueSoftness), 0, 180),
    windowCenterX: clamp01(finiteOr(raw.windowCenterX, defaults.windowCenterX)),
    windowCenterY: clamp01(finiteOr(raw.windowCenterY, defaults.windowCenterY)),
    windowWidth: clamp01(finiteOr(raw.windowWidth, defaults.windowWidth)),
    windowHeight: clamp01(finiteOr(raw.windowHeight, defaults.windowHeight)),
    windowRotation: clamp(finiteOr(raw.windowRotation, defaults.windowRotation), -180, 180),
    windowFeather: clamp01(finiteOr(raw.windowFeather, defaults.windowFeather)),
    hueShift: clamp(finiteOr(raw.hueShift, defaults.hueShift), -180, 180),
    satScale: clamp(finiteOr(raw.satScale, defaults.satScale), 0, 3),
    lumOffset: clamp(finiteOr(raw.lumOffset, defaults.lumOffset), -1, 1),
    satOffset: clamp(finiteOr(raw.satOffset, defaults.satOffset), -1, 1),
    invertMask: Boolean(raw.invertMask ?? defaults.invertMask),
  };
}

/** Normalize raw / partial secondary color fields onto defaults (max 3 grades). */
export function normalizeSecondaryColorPass(
  raw: Partial<SecondaryColorSettings> | undefined,
  defaults: SecondaryColorSettings,
): SecondaryColorSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      ...defaults,
      grades: defaults.grades.map((g) => ({ ...g })),
    };
  }
  const enabled = Boolean(raw.enabled);
  const amount = Number.isFinite(raw.amount)
    ? clamp01(raw.amount as number)
    : (defaults.amount ?? 1);
  const rawGrades = Array.isArray(raw.grades) ? raw.grades : defaults.grades;
  const grades = rawGrades
    .slice(0, MAX_SECONDARY_GRADES)
    .map((g) => normalizeSecondaryGrade(g as Partial<SecondaryGrade>));
  return { enabled, amount, grades };
}

export function isSecondaryGradeNeutral(grade: SecondaryGrade | undefined): boolean {
  if (!grade) return true;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  return (
    near(grade.hueShift, 0) &&
    near(grade.satScale, 1) &&
    near(grade.lumOffset, 0) &&
    near(grade.satOffset, 0)
  );
}

/** True when any enabled grade has a non-neutral adjustment. */
export function hasActiveSecondaryGrades(pass: SecondaryColorSettings | undefined): boolean {
  if (!pass?.grades?.length) return false;
  return pass.grades.some((g) => g.enabled && !isSecondaryGradeNeutral(g));
}

export function createSecondaryGrade(
  partial: Partial<SecondaryGrade> = {},
): SecondaryGrade {
  return normalizeSecondaryGrade({ ...DEFAULT_SECONDARY_GRADE, ...partial });
}

export function createSecondaryGradeFromPreset(presetId: string): SecondaryGrade {
  const preset = SECONDARY_GRADE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return createSecondaryGrade();
  return { ...preset.grade };
}

/** Hue qualifier mask 0 … 1 (CPU mirror of WGSL). */
export function evaluateHueMask(
  hueDeg: number,
  center: number,
  width: number,
  softness: number,
): number {
  const halfWidth = Math.max(width, 0) * 0.5;
  if (halfWidth <= 0) return 0;
  const soft = Math.max(softness, 1e-4);
  const dist = hueDistanceDegrees(hueDeg, center);
  return 1 - smoothstep(halfWidth - soft, halfWidth + soft, dist);
}

/** Soft elliptical window mask 0 … 1 in normalized UV. */
export function evaluateWindowMask(
  u: number,
  v: number,
  grade: Pick<
    SecondaryGrade,
    | 'windowCenterX'
    | 'windowCenterY'
    | 'windowWidth'
    | 'windowHeight'
    | 'windowRotation'
    | 'windowFeather'
  >,
): number {
  const halfW = Math.max(grade.windowWidth * 0.5, 1e-4);
  const halfH = Math.max(grade.windowHeight * 0.5, 1e-4);
  const dx = u - grade.windowCenterX;
  const dy = v - grade.windowCenterY;
  const rad = (grade.windowRotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rx = dx * c + dy * s;
  const ry = -dx * s + dy * c;
  const qx = rx / halfW;
  const qy = ry / halfH;
  const d = Math.hypot(qx, qy);
  const feather = Math.max(grade.windowFeather, 1e-4);
  return 1 - smoothstep(1 - feather, 1 + feather, d);
}

export function evaluateGradeMask(
  hueDeg: number,
  u: number,
  v: number,
  grade: SecondaryGrade,
): number {
  const maskType = grade.maskType;
  let mask = 1;
  if (maskType === 'hue') {
    mask = evaluateHueMask(hueDeg, grade.hueCenter, grade.hueWidth, grade.hueSoftness);
  } else if (maskType === 'window') {
    mask = evaluateWindowMask(u, v, grade);
  } else {
    // hue+window — intersection
    const hueM = evaluateHueMask(hueDeg, grade.hueCenter, grade.hueWidth, grade.hueSoftness);
    const winM = evaluateWindowMask(u, v, grade);
    mask = hueM * winM;
  }
  if (grade.invertMask) mask = 1 - mask;
  return clamp01(mask);
}

function applyGradeToHsl(
  h: number,
  s: number,
  l: number,
  grade: SecondaryGrade,
  mask: number,
): [number, number, number] {
  if (mask <= 0) return [h, s, l];
  const h2 = wrapHueDegrees(h + grade.hueShift * mask);
  const s2 = clamp01(s + (s * (grade.satScale - 1) + grade.satOffset) * mask);
  const l2 = clamp01(l + grade.lumOffset * mask);
  return [h2, s2, l2];
}

/**
 * Apply the secondary stack to one RGB sample.
 * `u`/`v` are normalized coords for window masks (ignored for pure hue bake).
 */
export function applySecondaryStackToRgb(
  r: number,
  g: number,
  b: number,
  pass: SecondaryColorSettings,
  u = 0.5,
  v = 0.5,
  options?: { hueOnly?: boolean },
): [number, number, number] {
  if (!pass.enabled) return [r, g, b];
  const amount = clamp01(pass.amount ?? 1);
  if (amount <= 0) return [r, g, b];

  let [h, s, l] = rgbToHsl(r, g, b);
  for (const grade of pass.grades) {
    if (!grade.enabled || isSecondaryGradeNeutral(grade)) continue;
    if (options?.hueOnly && grade.maskType === 'window') continue;
    if (options?.hueOnly && grade.maskType === 'hue+window') {
      // Bake hue qualifier only (full-frame) — windows cannot live in a 3D LUT.
      const mask = evaluateHueMask(h, grade.hueCenter, grade.hueWidth, grade.hueSoftness);
      const inv = grade.invertMask ? 1 - mask : mask;
      [h, s, l] = applyGradeToHsl(h, s, l, grade, inv);
      continue;
    }
    const mask = evaluateGradeMask(h, u, v, grade);
    [h, s, l] = applyGradeToHsl(h, s, l, grade, mask);
  }

  const [or, og, ob] = hslToRgb(h, s, l);
  return [
    clamp01(r + (or - r) * amount),
    clamp01(g + (og - g) * amount),
    clamp01(b + (ob - b) * amount),
  ];
}

/** Encode mask type for WGSL (0=hue, 1=window, 2=hue+window). */
export function maskTypeToUniform(maskType: SecondaryMaskType): number {
  if (maskType === 'window') return 1;
  if (maskType === 'hue+window') return 2;
  return 0;
}

/**
 * Pack SecondaryColorPass into a Float32Array matching WGSL SecondaryColorUniforms.
 *
 * Layout:
 *   [0] amount, gradeCount, pad, pad
 *   per grade (20 floats):
 *     enabled, maskMode, invert, pad
 *     hueCenter (0–1), hueWidth (0–1), hueSoftness (0–1), pad
 *     winCenterX, winCenterY, winWidth, winHeight
 *     winRotation (rad), winFeather, pad, pad
 *     hueShift (turns), satScale, lumOffset, satOffset
 */
export function packSecondaryColorUniforms(
  pass: SecondaryColorSettings,
  out: Float32Array = new Float32Array(SECONDARY_COLOR_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < SECONDARY_COLOR_UNIFORM_FLOATS) {
    throw new Error(
      `Secondary color uniform buffer needs ${SECONDARY_COLOR_UNIFORM_FLOATS} floats`,
    );
  }
  out.fill(0);
  const amount = pass.enabled ? clamp01(pass.amount ?? 1) : 0;
  const grades = pass.grades.slice(0, MAX_SECONDARY_GRADES);
  out[0] = amount;
  out[1] = grades.length;
  out[2] = 0;
  out[3] = 0;

  for (let i = 0; i < MAX_SECONDARY_GRADES; i++) {
    const base = 4 + i * SECONDARY_GRADE_UNIFORM_FLOATS;
    const grade = grades[i];
    if (!grade) continue;
    out[base + 0] = grade.enabled ? 1 : 0;
    out[base + 1] = maskTypeToUniform(grade.maskType);
    out[base + 2] = grade.invertMask ? 1 : 0;
    out[base + 3] = 0;

    out[base + 4] = wrapHueDegrees(grade.hueCenter) / 360;
    out[base + 5] = clamp(grade.hueWidth, 0, 360) / 360;
    out[base + 6] = clamp(grade.hueSoftness, 0, 180) / 360;
    out[base + 7] = 0;

    out[base + 8] = grade.windowCenterX;
    out[base + 9] = grade.windowCenterY;
    out[base + 10] = grade.windowWidth;
    out[base + 11] = grade.windowHeight;

    out[base + 12] = (grade.windowRotation * Math.PI) / 180;
    out[base + 13] = grade.windowFeather;
    out[base + 14] = 0;
    out[base + 15] = 0;

    out[base + 16] = grade.hueShift / 360;
    out[base + 17] = grade.satScale;
    out[base + 18] = grade.lumOffset;
    out[base + 19] = grade.satOffset;
  }

  return out;
}

const SECONDARY_LUT_SIZE = 17;
export const SECONDARY_COLOR_LUT_FILENAME = 'secondary_grade.cube';

/** True when any active grade uses a spatial window (no FFmpeg / LUT parity). */
export function secondaryHasWindowGrades(pass: SecondaryColorSettings | undefined): boolean {
  if (!pass?.grades) return false;
  return pass.grades.some(
    (g) =>
      g.enabled &&
      !isSecondaryGradeNeutral(g) &&
      (g.maskType === 'window' || g.maskType === 'hue+window'),
  );
}

/** True when any active grade is hue-based (bakeable into a 3D LUT). */
export function secondaryHasHueGrades(pass: SecondaryColorSettings | undefined): boolean {
  if (!pass?.grades) return false;
  return pass.grades.some(
    (g) =>
      g.enabled &&
      !isSecondaryGradeNeutral(g) &&
      (g.maskType === 'hue' || g.maskType === 'hue+window'),
  );
}

/**
 * Bake hue-only secondary stack into a 3D LUT (windows ignored).
 * Returns null when disabled / no bakeable grades.
 */
export function bakeSecondaryColorLut(
  pass: SecondaryColorSettings | undefined,
  size = SECONDARY_LUT_SIZE,
): LutData | null {
  if (!pass?.enabled) return null;
  if (clamp01(pass.amount ?? 1) <= 0) return null;
  if (!secondaryHasHueGrades(pass)) return null;

  const data = new Float32Array(size ** 3 * 3);
  let idx = 0;
  for (let bi = 0; bi < size; bi++) {
    const b = bi / (size - 1);
    for (let gi = 0; gi < size; gi++) {
      const g = gi / (size - 1);
      for (let ri = 0; ri < size; ri++) {
        const r = ri / (size - 1);
        const [or, og, ob] = applySecondaryStackToRgb(r, g, b, pass, 0.5, 0.5, {
          hueOnly: true,
        });
        data[idx++] = or;
        data[idx++] = og;
        data[idx++] = ob;
      }
    }
  }
  return { size, data };
}

/** Serialize LutData to Adobe `.cube` text for FFmpeg `lut3d`. */
export function secondaryLutToCubeText(lut: LutData, title = 'SecondaryColor'): string {
  const lines: string[] = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${lut.size}`,
  ];
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(
      `${fmtCube(lut.data[i])} ${fmtCube(lut.data[i + 1])} ${fmtCube(lut.data[i + 2])}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function fmtCube(n: number): string {
  return Number(clamp01(n).toFixed(6)).toString();
}

/**
 * Build FFmpeg video filter for secondary color (best-effort).
 *
 * Hue-only grades → `lut3d=<file>` (caller must write the cube via
 * {@link bakeSecondaryColorLut} / {@link secondaryLutToCubeText}).
 * Window grades have no FFmpeg parity.
 *
 * Returns '' when nothing bakeable is active.
 */
export function buildSecondaryColorFfmpegFilters(
  pass: SecondaryColorSettings | undefined,
  lutFileName = SECONDARY_COLOR_LUT_FILENAME,
): string {
  if (!pass?.enabled) return '';
  if (clamp01(pass.amount ?? 1) <= 0) return '';
  if (!secondaryHasHueGrades(pass)) return '';
  // Escape path for filtergraph — keep filename simple (no commas/brackets).
  const safe = lutFileName.replace(/['\\:]/g, '');
  return `lut3d=${safe}`;
}

/**
 * Append secondary-color filters onto a filter_complex that ends at `[vout]`.
 */
export function appendSecondaryColorFilters(
  filterComplex: string,
  pass: SecondaryColorSettings | undefined,
  lutFileName = SECONDARY_COLOR_LUT_FILENAME,
): string {
  const chain = buildSecondaryColorFfmpegFilters(pass, lutFileName);
  if (!chain) return filterComplex;
  const rewritten = filterComplex.replace(/\[vout\]/g, '[vpresecondary]');
  return `${rewritten};[vpresecondary]${chain}[vout]`;
}
