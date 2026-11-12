/**
 * Explicit color pipeline for the WebGPU compositor.
 *
 * Default (`rec709` working space + `rec709-sdr` output) does not run any of
 * these transforms — finishing stays on the existing 8-bit Rec.709 chain.
 * Anything else converts assumed-Rec.709 code into scene-linear Rec.2020,
 * grades there, then applies an output transform before display-referred grain.
 *
 * Matrices are D65, row-major. The same numbers are packed into the WGSL
 * uniform so the shader cannot drift from this module. No OCIO.
 *
 * Sources: with management on, `importExternalTexture` converts every layer
 * to encoded Display P3 using the frame's own colour tags (or a clip's
 * `colorSpaceOverride`, applied on the decoder), so a P3 source keeps its
 * gamut; the input transform then decodes P3. Untagged media is Rec.709.
 */

export type OutputColor = 'rec709-sdr' | 'display-p3' | 'hdr10';
export type WorkingSpace = 'rec709' | 'rec2020-linear';

export interface ColorManagementSettings {
  outputColor: OutputColor;
  workingSpace: WorkingSpace;
  /**
   * HDR10: luminance titles and captions are composited at (ITU-R BT.2408
   * graphics white). Omitted = {@link DEFAULT_GRAPHICS_WHITE_NITS}.
   */
  graphicsWhiteNits?: number;
}

export const DEFAULT_COLOR_MANAGEMENT: ColorManagementSettings = {
  outputColor: 'rec709-sdr',
  workingSpace: 'rec709',
};

/**
 * Scene-linear 1.0 maps to this many nits in the PQ output transform
 * (diffuse white). 10,000 nits is the PQ peak, not the grade white.
 */
export const PQ_REFERENCE_WHITE_NITS = 100;

/** ITU-R BT.2408 graphics white: where HDR10 titles and captions sit. */
export const DEFAULT_GRAPHICS_WHITE_NITS = 203;
export const GRAPHICS_WHITE_NITS_RANGE = { min: 80, max: 1000 } as const;

export function resolveGraphicsWhiteNits(
  settings: Pick<ColorManagementSettings, 'graphicsWhiteNits'> | undefined | null,
): number {
  const value = settings?.graphicsWhiteNits;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_GRAPHICS_WHITE_NITS;
  return Math.min(GRAPHICS_WHITE_NITS_RANGE.max, Math.max(GRAPHICS_WHITE_NITS_RANGE.min, value));
}

/**
 * Scene-linear gain for sRGB-encoded graphics composited before the HDR10
 * output transform: 1.0 sRGB white lands at the graphics white.
 */
export function graphicsWhiteSceneGain(
  settings: Pick<ColorManagementSettings, 'graphicsWhiteNits'> | undefined | null,
): number {
  return resolveGraphicsWhiteNits(settings) / PQ_REFERENCE_WHITE_NITS;
}

/** Managed-mode pass order. Grain stays last, on the output encoding. */
export const COLOR_MANAGED_PASS_ORDER = [
  'input',
  'noise',
  'primary',
  'curves',
  'secondary',
  'lut',
  'sharpen',
  'chromaticAberration',
  'bloom',
  'output',
  'grain',
  'present',
] as const;

const HDR10_UNAVAILABLE_REASON =
  'HEVC Main10 and AV1 10-bit are not available in this browser.';

const DISPLAY_P3_UNAVAILABLE_REASON =
  'This browser did not accept a Display P3 video encoder configuration.';

export class ColorPipelineExportError extends Error {
  readonly colorPipeline = true;

  constructor(message: string) {
    super(message);
    this.name = 'ColorPipelineExportError';
  }
}

export function isColorPipelineExportError(err: unknown): err is ColorPipelineExportError {
  return err instanceof ColorPipelineExportError || (
    typeof err === 'object' &&
    err !== null &&
    (err as { colorPipeline?: boolean }).colorPipeline === true
  );
}

/** Row-major 3×3. */
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

/** Rec.709 / sRGB primaries, D65, RGB → XYZ. CSS Color 4. */
export const REC709_TO_XYZ: Mat3 = [
  0.41239079926595934, 0.357584339383878, 0.1804807884018343,
  0.21263900587151027, 0.715168678767756, 0.07219231536073371,
  0.01933081871559182, 0.11919477979462598, 0.9505321522496607,
];

/** Rec.2020 primaries, D65, RGB → XYZ. ITU-R BT.2020. */
export const REC2020_TO_XYZ: Mat3 = [
  0.6369580483012914, 0.14461690358620832, 0.1688809751641721,
  0.2627002120112671, 0.6779980715188708, 0.05930171646986196,
  0.0, 0.028072693049087428, 1.060985057710791,
];

/** Display P3 primaries, D65, RGB → XYZ. CSS Color 4. */
export const DISPLAY_P3_TO_XYZ: Mat3 = [
  0.4865709486482162, 0.26566769316909306, 0.1982172852343625,
  0.2289745640697488, 0.6917385218365064, 0.079286914093745,
  0.0, 0.04511338185890264, 1.043944368900976,
];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      o[row * 3 + col] =
        a[row * 3]! * b[col]! +
        a[row * 3 + 1]! * b[3 + col]! +
        a[row * 3 + 2]! * b[6 + col]!;
    }
  }
  return o as unknown as Mat3;
}

export function invertMat3(m: Mat3): Mat3 {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[3];
  const e = m[4];
  const f = m[5];
  const g = m[6];
  const h = m[7];
  const i = m[8];
  const c00 = e * i - f * h;
  const c01 = f * g - d * i;
  const c02 = d * h - e * g;
  const c10 = c * h - b * i;
  const c11 = a * i - c * g;
  const c12 = b * g - a * h;
  const c20 = b * f - c * e;
  const c21 = c * d - a * f;
  const c22 = a * e - b * d;
  const det = a * c00 + b * c01 + c * c02;
  if (Math.abs(det) < 1e-12) throw new Error('singular color matrix');
  const inv = 1 / det;
  return [
    c00 * inv, c10 * inv, c20 * inv,
    c01 * inv, c11 * inv, c21 * inv,
    c02 * inv, c12 * inv, c22 * inv,
  ];
}

export function mulMat3Vec(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const XYZ_TO_REC709 = invertMat3(REC709_TO_XYZ);
const XYZ_TO_REC2020 = invertMat3(REC2020_TO_XYZ);
const XYZ_TO_DISPLAY_P3 = invertMat3(DISPLAY_P3_TO_XYZ);

export const REC709_TO_REC2020: Mat3 = mulMat3(XYZ_TO_REC2020, REC709_TO_XYZ);
export const DISPLAY_P3_TO_REC2020: Mat3 = mulMat3(XYZ_TO_REC2020, DISPLAY_P3_TO_XYZ);
export const REC2020_TO_REC709: Mat3 = mulMat3(XYZ_TO_REC709, REC2020_TO_XYZ);
export const REC2020_TO_DISPLAY_P3: Mat3 = mulMat3(XYZ_TO_DISPLAY_P3, REC2020_TO_XYZ);
export const DISPLAY_P3_TO_REC709: Mat3 = mulMat3(XYZ_TO_REC709, DISPLAY_P3_TO_XYZ);

/** ST 2084 constants (ITU-R BT.2100). */
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** Absolute PQ code (0–1) for a luminance in nits. 0 nits → 0, 10,000 nits → 1. */
export function nitsToPq(nits: number): number {
  if (nits <= 0) return 0;
  const y = nits / 10000;
  const ym = y ** PQ_M1;
  return ((PQ_C1 + PQ_C2 * ym) / (1 + PQ_C3 * ym)) ** PQ_M2;
}

/** Inverse of {@link nitsToPq}. */
export function pqToNits(code: number): number {
  if (code <= 0) return 0;
  const e = code ** (1 / PQ_M2);
  const num = Math.max(e - PQ_C1, 0);
  const den = Math.max(PQ_C2 - PQ_C3 * e, 1e-12);
  return (num / den) ** (1 / PQ_M1) * 10000;
}

/**
 * Settings for a 2D canvas the export composes the frame and its text on.
 * In Display P3 the GPU canvas is P3; a bare `getContext('2d')` is sRGB, so
 * `drawImage` would convert the frame down to sRGB (gamut-clipping it and the
 * text drawn over it) before the P3-tagged encode. The frame is opaque, so
 * no alpha channel.
 */
export function exportCanvas2dSettings(outputColor: OutputColor): CanvasRenderingContext2DSettings {
  return { colorSpace: outputColor === 'display-p3' ? 'display-p3' : 'srgb', alpha: false };
}

/**
 * Scene-linear channel (1 = {@link PQ_REFERENCE_WHITE_NITS}) → PQ code.
 */
export function linearToPq(
  linear: number,
  referenceWhiteNits: number = PQ_REFERENCE_WHITE_NITS,
): number {
  return nitsToPq(Math.max(linear, 0) * referenceWhiteNits);
}

export function isColorManagementActive(
  settings: ColorManagementSettings | undefined | null,
): boolean {
  if (!settings) return false;
  return settings.outputColor !== 'rec709-sdr' || settings.workingSpace !== 'rec709';
}

export function normalizeColorManagement(raw: unknown): ColorManagementSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_COLOR_MANAGEMENT };
  const value = raw as Partial<ColorManagementSettings>;
  const outputColor: OutputColor =
    value.outputColor === 'display-p3' || value.outputColor === 'hdr10'
      ? value.outputColor
      : 'rec709-sdr';
  const workingSpace: WorkingSpace =
    value.workingSpace === 'rec2020-linear' ? 'rec2020-linear' : 'rec709';
  const out: ColorManagementSettings = { outputColor, workingSpace };
  if (typeof value.graphicsWhiteNits === 'number' && Number.isFinite(value.graphicsWhiteNits)) {
    out.graphicsWhiteNits = resolveGraphicsWhiteNits(value);
  }
  return out;
}

/**
 * WebCodecs color tags, including values the bundled DOM lib does not list yet
 * (`bt2020`, `pq`, `smpte432`). Browsers that implement the current spec accept
 * them on `VideoEncoderConfig.colorSpace`.
 */
export interface OutputVideoColorSpace {
  primaries?: 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020' | 'smpte432';
  transfer?: 'bt709' | 'smpte170m' | 'iec61966-2-1' | 'linear' | 'pq' | 'hlg';
  matrix?: 'rgb' | 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020-ncl';
  fullRange?: boolean;
}

export const DISPLAY_P3_COLOR_SPACE: Readonly<OutputVideoColorSpace> = Object.freeze({
  primaries: 'smpte432',
  transfer: 'iec61966-2-1',
  matrix: 'rgb',
  fullRange: true,
});

export const HDR10_COLOR_SPACE: Readonly<OutputVideoColorSpace> = Object.freeze({
  primaries: 'bt2020',
  transfer: 'pq',
  matrix: 'bt2020-ncl',
  fullRange: false,
});

/**
 * Rec.709 limited-range tags. Same fields as `REC709_COLOR_SPACE` in
 * `webcodecsCodec.ts` — kept here so this module does not import the encoder.
 */
export const REC709_SDR_COLOR_SPACE: Readonly<OutputVideoColorSpace> = Object.freeze({
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
});

export function colorSpaceForOutput(output: OutputColor): OutputVideoColorSpace {
  switch (output) {
    case 'display-p3':
      return DISPLAY_P3_COLOR_SPACE;
    case 'hdr10':
      return HDR10_COLOR_SPACE;
    default:
      return REC709_SDR_COLOR_SPACE;
  }
}

export type CanvasColorSpaceId = 'srgb' | 'display-p3';
export type CanvasToneMappingMode = 'standard' | 'extended';

export interface CanvasColorRequest {
  colorSpace: CanvasColorSpaceId;
  toneMapping: CanvasToneMappingMode;
}

export type PresentMode = 'identity' | 'p3-to-srgb' | 'pq-to-extended' | 'pq-to-sdr';

export interface CanvasPresentation {
  colorSpace: CanvasColorSpaceId;
  toneMapping: CanvasToneMappingMode;
  present: PresentMode;
  presentFallback: boolean;
}

/**
 * What the canvas is for: a `display` canvas is on screen (the preview); an
 * `offscreen` one only feeds an encoder or a readback (export, harness).
 */
export type CanvasSurface = 'display' | 'offscreen';

export interface CanvasSurfacePlan extends CanvasColorRequest {
  format: GPUTextureFormat;
}

/** The float swapchain format: extended range, and > 8 bits through compositing. */
export const FLOAT_CANVAS_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * Swapchain format and colour for one engine. Compositing draws into the
 * canvas, so its format is also the compositing precision.
 *
 * - HDR10 on an HDR display: `rgba16float` + `extended` in Display P3, so
 *   the preview shows highlights above SDR white (`pq-to-extended`).
 * - HDR10 offscreen (export / harness): `rgba16float`, so layers composite
 *   with more than 8 bits before the PQ output transform; it is never shown.
 * - HDR10 on an SDR display: the preferred 8-bit format, `pq-to-sdr`.
 * - Everything else keeps the preferred format; Display P3 asks for a P3
 *   canvas (an encoder reads it, so it stays 8-bit RGBA).
 */
export function planCanvasSurface(
  output: OutputColor,
  surface: CanvasSurface,
  displayHdr: boolean,
  preferredFormat: GPUTextureFormat,
): CanvasSurfacePlan {
  switch (output) {
    case 'display-p3':
      return { format: preferredFormat, colorSpace: 'display-p3', toneMapping: 'standard' };
    case 'hdr10':
      if (surface === 'offscreen') {
        return { format: FLOAT_CANVAS_FORMAT, colorSpace: 'srgb', toneMapping: 'standard' };
      }
      if (displayHdr) {
        return { format: FLOAT_CANVAS_FORMAT, colorSpace: 'display-p3', toneMapping: 'extended' };
      }
      return { format: preferredFormat, colorSpace: 'srgb', toneMapping: 'standard' };
    default:
      return { format: preferredFormat, colorSpace: 'srgb', toneMapping: 'standard' };
  }
}

/**
 * `importExternalTexture` colour space. Managed: every source is converted
 * to encoded Display P3 by the browser from the frame's own tags, so P3
 * footage is not clipped to sRGB first; the input transform then decodes P3.
 * Unmanaged stays sRGB, byte-identical to before.
 */
export function importColorSpaceFor(
  settings: ColorManagementSettings | undefined | null,
): PredefinedColorSpace {
  return isColorManagementActive(settings) ? 'display-p3' : 'srgb';
}

/** Presentation after a configure attempt. `configured` is what actually stuck. */
export function resolveCanvasPresentation(
  output: OutputColor,
  configured: CanvasColorRequest,
  canvasFormat: string,
): CanvasPresentation {
  // Only a float swapchain can hold values above 1; an 8-bit `extended`
  // canvas would still show a 100-nit downmap.
  const floatCanvas = canvasFormat === FLOAT_CANVAS_FORMAT;
  if (output === 'display-p3') {
    if (configured.colorSpace === 'display-p3') {
      return {
        colorSpace: 'display-p3',
        toneMapping: 'standard',
        present: 'identity',
        presentFallback: false,
      };
    }
    return {
      colorSpace: 'srgb',
      toneMapping: 'standard',
      present: 'p3-to-srgb',
      presentFallback: true,
    };
  }
  if (output === 'hdr10') {
    if (configured.toneMapping === 'extended' && floatCanvas) {
      return {
        colorSpace: configured.colorSpace,
        toneMapping: 'extended',
        present: 'pq-to-extended',
        presentFallback: false,
      };
    }
    return {
      colorSpace: configured.colorSpace,
      toneMapping: configured.toneMapping,
      present: 'pq-to-sdr',
      presentFallback: true,
    };
  }
  return {
    colorSpace: 'srgb',
    toneMapping: 'standard',
    present: 'identity',
    presentFallback: false,
  };
}

/** WGSL `ColorXformUniforms.mode`. Keep in sync with colorManagement.wgsl. */
export const ColorXformMode = {
  inputRec709ToLinear2020: 0,
  odtRec709: 1,
  odtDisplayP3: 2,
  odtPq: 3,
  presentIdentity: 4,
  presentP3ToSrgb: 5,
  presentPqToExtended: 6,
  presentPqToSdr: 7,
  inputDisplayP3ToLinear2020: 8,
  presentPqToExtendedP3: 9,
} as const;

export type ColorXformModeId = (typeof ColorXformMode)[keyof typeof ColorXformMode];

export const COLOR_XFORM_UNIFORM_FLOATS = 16;

export function matrixForXform(mode: ColorXformModeId): Mat3 {
  switch (mode) {
    case ColorXformMode.inputRec709ToLinear2020:
      return REC709_TO_REC2020;
    case ColorXformMode.inputDisplayP3ToLinear2020:
      return DISPLAY_P3_TO_REC2020;
    case ColorXformMode.presentPqToExtendedP3:
      return REC2020_TO_DISPLAY_P3;
    case ColorXformMode.odtRec709:
    case ColorXformMode.presentPqToExtended:
    case ColorXformMode.presentPqToSdr:
      return REC2020_TO_REC709;
    case ColorXformMode.odtDisplayP3:
      return REC2020_TO_DISPLAY_P3;
    case ColorXformMode.presentP3ToSrgb:
      return DISPLAY_P3_TO_REC709;
    default:
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
}

export function packColorXformUniforms(
  mode: ColorXformModeId,
  out: Float32Array = new Float32Array(COLOR_XFORM_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < COLOR_XFORM_UNIFORM_FLOATS) {
    throw new Error(`Color transform uniform buffer needs ${COLOR_XFORM_UNIFORM_FLOATS} floats`);
  }
  const m = matrixForXform(mode);
  out.fill(0);
  out[0] = mode;
  out[1] = PQ_REFERENCE_WHITE_NITS;
  out[4] = m[0];
  out[5] = m[1];
  out[6] = m[2];
  out[8] = m[3];
  out[9] = m[4];
  out[10] = m[5];
  out[12] = m[6];
  out[13] = m[7];
  out[14] = m[8];
  return out;
}

export function odtModeForOutput(output: OutputColor): ColorXformModeId {
  switch (output) {
    case 'display-p3':
      return ColorXformMode.odtDisplayP3;
    case 'hdr10':
      return ColorXformMode.odtPq;
    default:
      return ColorXformMode.odtRec709;
  }
}

/** Input transform for what `importColorSpaceFor` asked the browser for. */
export function inputModeFor(importColorSpace: PredefinedColorSpace): ColorXformModeId {
  return importColorSpace === 'display-p3'
    ? ColorXformMode.inputDisplayP3ToLinear2020
    : ColorXformMode.inputRec709ToLinear2020;
}

export function presentModeToXform(
  present: PresentMode,
  canvasColorSpace: CanvasColorSpaceId = 'srgb',
): ColorXformModeId {
  switch (present) {
    case 'p3-to-srgb':
      return ColorXformMode.presentP3ToSrgb;
    case 'pq-to-extended':
      return canvasColorSpace === 'display-p3'
        ? ColorXformMode.presentPqToExtendedP3
        : ColorXformMode.presentPqToExtended;
    case 'pq-to-sdr':
      return ColorXformMode.presentPqToSdr;
    default:
      return ColorXformMode.presentIdentity;
  }
}

/** Marker replaced when building the scene-linear finishing pipeline variant. */
export const SCENE_LINEAR_MARKER = 'const SCENE_LINEAR: bool = false;';

export function shaderForSceneLinear(code: string, sceneLinear: boolean): string {
  if (!sceneLinear) return code;
  if (!code.includes(SCENE_LINEAR_MARKER)) {
    throw new Error('finishing shader is missing the SCENE_LINEAR marker');
  }
  return code.replace(SCENE_LINEAR_MARKER, 'const SCENE_LINEAR: bool = true;');
}

/** `bytesPerRow` for an RGBA8 `copyTextureToBuffer` of `width` pixels. */
export function rgbaRowStride(width: number): number {
  return Math.ceil((width * 4) / 256) * 256;
}

export function unpadRgbaRows(
  src: Uint8Array,
  width: number,
  height: number,
  stride: number,
): Uint8Array {
  const tight = width * 4;
  if (stride === tight) return src.slice(0, tight * height);
  const out = new Uint8Array(tight * height);
  for (let y = 0; y < height; y++) {
    out.set(src.subarray(y * stride, y * stride + tight), y * tight);
  }
  return out;
}

export function stampWideColor<T extends object>(
  plan: T,
  where: 'gpu' | 'ignored',
  color: ColorManagementSettings | undefined | null,
): T & { wideColor?: 'gpu' | 'ignored' } {
  if (!isColorManagementActive(color)) return plan;
  return { ...plan, wideColor: where };
}

export function hdr10UnavailableReason(): string {
  return HDR10_UNAVAILABLE_REASON;
}

export function displayP3UnavailableReason(): string {
  return DISPLAY_P3_UNAVAILABLE_REASON;
}

export interface ColorDebugSnapshot {
  outputColor: OutputColor;
  workingSpace: WorkingSpace;
  /** What `importExternalTexture` converts sources to. */
  importColorSpace?: PredefinedColorSpace;
  /** `(dynamic-range: high)` as the engine last heard it. */
  displayHdr?: boolean;
  canvasColorSpace: CanvasColorSpaceId;
  toneMapping: CanvasToneMappingMode;
  canvasFormat: string;
  present: PresentMode;
  presentFallback: boolean;
}

const DEFAULT_COLOR_DEBUG: ColorDebugSnapshot = {
  outputColor: 'rec709-sdr',
  workingSpace: 'rec709',
  canvasColorSpace: 'srgb',
  toneMapping: 'standard',
  canvasFormat: '',
  present: 'identity',
  presentFallback: false,
};

let colorDebugSnapshot: ColorDebugSnapshot = { ...DEFAULT_COLOR_DEBUG };

export function publishColorDebugSnapshot(next: ColorDebugSnapshot): void {
  colorDebugSnapshot = { ...next };
}

export function getColorDebugSnapshot(): ColorDebugSnapshot {
  return { ...colorDebugSnapshot };
}

function __resetColorDebugForTests(): void {
  colorDebugSnapshot = { ...DEFAULT_COLOR_DEBUG };
}
