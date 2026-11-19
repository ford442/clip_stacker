/**
 * The uniform specs of the finishing passes, the overlay key and the preview
 * layer draw: the one definition of each WGSL uniform struct (see
 * `uniformLayout.ts`). Each shader carries a `// @uniforms <StructName>` line
 * where the emitted struct is spliced; each TS packer fills `pack(values)`.
 *
 * Slot numbers that CPU references read (`SHARPEN_MODE_SLOT`,
 * `NR_QUALITY_SLOT`, …) are `offsets` of these specs, never literals. The
 * "classic" / "standard" modes are pinned byte-identical to before the modes
 * existed, so changing a spec here is a layout change for every saved project
 * look: append, do not reorder.
 *
 * This module imports nothing but `uniformLayout.ts`, so the finishing
 * modules (which own the packing maths) and the passes can both import it
 * without a cycle.
 */

import { defineUniformLayout } from './uniformLayout';

/**
 * Knots per channel the curves shader has room for. `finishing/curves.ts`
 * caps a curve at it (`CURVE_MAX_POINTS`); `curves.wgsl` repeats it as
 * `CURVE_MAX_POINTS` (checked by `curves.test.ts`).
 */
export const CURVE_KNOTS_PER_CHANNEL = 16;

/** Film grain + optical emulation (`grain.wgsl`), always the last pass. */
export const GRAIN_UNIFORMS = defineUniformLayout('GrainUniforms', [
  { name: 'amount', type: 'f32', doc: 'vec4 0' },
  { name: 'size', type: 'f32' },
  { name: 'softness', type: 'f32' },
  { name: 'monochrome', type: 'f32' },
  { name: 'vignetteAmount', type: 'f32', doc: 'vec4 1' },
  { name: 'vignetteMidpoint', type: 'f32' },
  { name: 'vignetteRoundness', type: 'f32' },
  { name: 'frameSeed', type: 'f32' },
  { name: 'halationAmount', type: 'f32', doc: 'vec4 2' },
  { name: 'halationThreshold', type: 'f32' },
  { name: 'halationRadius', type: 'f32' },
  { name: 'bloomAmount', type: 'f32' },
  { name: 'texelSize', type: 'vec2', doc: 'vec4 3 (blurAxis is set per draw by GrainGpuPass)' },
  { name: 'blurAxis', type: 'f32' },
  { name: '_pad1', type: 'f32' },
  { name: 'quality', type: 'f32', doc: 'vec4 4: film quality mode (all zero = classic, the pre-film behaviour)' },
  { name: 'monochromeBias', type: 'f32' },
  { name: 'temporalCoherence', type: 'f32' },
  { name: '_pad2', type: 'f32' },
  { name: 'responseShadows', type: 'f32', doc: 'vec4 5: film response curve (grain gain at luma 0 / 0.5 / 1)' },
  { name: 'responseMidtones', type: 'f32' },
  { name: 'responseHighlights', type: 'f32' },
  { name: '_pad3', type: 'f32' },
]);

/** Sharpen / detail (`sharpen.wgsl`). */
export const SHARPEN_UNIFORMS = defineUniformLayout('SharpenUniforms', [
  { name: 'amount', type: 'f32', doc: 'vec4 0' },
  { name: 'radius', type: 'f32' },
  { name: 'threshold', type: 'f32' },
  { name: 'midtoneDetail', type: 'f32' },
  { name: 'texelSize', type: 'vec2', doc: 'vec4 1' },
  { name: 'mode', type: 'f32', doc: '0 = classic unsharp, 1 = edge-aware, 2 = multi-scale.' },
  { name: '_pad1', type: 'f32' },
]);

/** Noise reduction (`denoise.wgsl`), the first finishing pass. */
export const NOISE_REDUCTION_UNIFORMS = defineUniformLayout('NoiseReductionUniforms', [
  { name: 'amount', type: 'f32', doc: 'vec4 0' },
  { name: 'spatialStrength', type: 'f32' },
  { name: 'spatialRadius', type: 'f32' },
  { name: 'temporalStrength', type: 'f32' },
  { name: 'temporalMotionThreshold', type: 'f32', doc: 'vec4 1' },
  { name: 'lumaOnly', type: 'f32' },
  { name: 'draft', type: 'f32' },
  { name: 'hasPrev', type: 'f32' },
  { name: 'texelSize', type: 'vec2', doc: 'vec4 2' },
  { name: 'quality', type: 'f32', doc: '0 = standard (original bilateral), 1 = high (guided bilateral), 2 = nlm.' },
  { name: '_pad1', type: 'f32' },
  { name: '_pad2', type: 'vec4', doc: 'vec4 3' },
]);

/** Curves & levels (`curves.wgsl`). */
export const CURVES_UNIFORMS = defineUniformLayout('CurvesUniforms', [
  { name: 'levels0', type: 'vec4', doc: 'inBlack, inWhite, gamma, outBlack' },
  { name: 'levels1', type: 'vec4', doc: 'outWhite, amount, pad, pad' },
  { name: 'counts', type: 'vec4', doc: 'knot counts: master, red, green, blue (0 = identity)' },
  {
    name: 'knots',
    type: 'vec4',
    count: 4 * CURVE_KNOTS_PER_CHANNEL,
    doc: `4 curves × ${CURVE_KNOTS_PER_CHANNEL} knots: (x, y, slope, pad)`,
  },
]);

/** Bloom / light-wrap pyramid (`bloom.wgsl`), one set per draw. */
export const BLOOM_UNIFORMS = defineUniformLayout('BloomUniforms', [
  { name: 'srcTexel', type: 'vec2', doc: 'vec4 0: source texel size, threshold, knee' },
  { name: 'threshold', type: 'f32' },
  { name: 'knee', type: 'f32' },
  { name: 'weight', type: 'f32', doc: 'vec4 1: upsample weight, mode (0 bloom / 1 light wrap), gain, norm' },
  { name: 'mode', type: 'f32' },
  { name: 'gain', type: 'f32' },
  { name: 'norm', type: 'f32' },
  { name: 'tint', type: 'vec3', doc: 'vec4 2: tint, pad' },
  { name: '_pad', type: 'f32' },
]);

/** Chromatic aberration (`chromaticAberration.wgsl`). */
export const CHROMATIC_ABERRATION_UNIFORMS = defineUniformLayout('ChromaticAberrationUniforms', [
  { name: 'radialK', type: 'f32', doc: 'vec4 0' },
  { name: 'dirX', type: 'f32' },
  { name: 'dirY', type: 'f32' },
  { name: 'spectral', type: 'f32' },
  { name: '_pad0', type: 'f32', doc: 'vec4 1' },
  { name: '_pad1', type: 'f32' },
  { name: '_pad2', type: 'f32' },
  { name: '_pad3', type: 'f32' },
]);

/**
 * The chroma / luma key block of the preview layer uniforms (filled by
 * `keyUniformValues` in `composition/overlayKey.ts`; `keyAlpha()` in
 * preview.wgsl reads it).
 */
export const KEY_UNIFORM_FIELDS = [
  {
    name: 'keyMode',
    type: 'f32',
    doc: 'Chroma / luma key (composition/overlayKey.ts keyPixel() is the TS twin). 0 none, 1 chroma, 2 luma.',
  },
  { name: 'keyR', type: 'f32' },
  { name: 'keyG', type: 'f32' },
  { name: 'keyB', type: 'f32' },
  { name: 'keySimilarity', type: 'f32' },
  { name: 'keyBlend', type: 'f32' },
] as const;

/** The per-layer draw uniforms of `preview.wgsl` (`packLayerUniforms`). */
export const PREVIEW_LAYER_UNIFORMS = defineUniformLayout('Uniforms', [
  { name: 'fadeIn', type: 'f32' },
  { name: 'fadeOut', type: 'f32' },
  { name: 'duration', type: 'f32' },
  { name: 'elapsed', type: 'f32' },
  { name: 'opacity', type: 'f32' },
  { name: 'uvScaleX', type: 'f32' },
  { name: 'uvScaleY', type: 'f32' },
  { name: 'uvOffsetX', type: 'f32' },
  { name: 'uvOffsetY', type: 'f32' },
  { name: 'destX', type: 'f32' },
  { name: 'destY', type: 'f32' },
  { name: 'destW', type: 'f32' },
  { name: 'destH', type: 'f32' },
  { name: 'bass', type: 'f32', doc: 'Audio-reactive (wasm/audioReactiveUniforms.ts); zeros when disabled' },
  { name: 'mid', type: 'f32' },
  { name: 'treble', type: 'f32' },
  { name: 'beat', type: 'f32' },
  {
    name: 'warpA',
    type: 'f32',
    doc: 'Layer warp: inverse 2x3 [a, b, tx, c, d, ty] in the dest rect UV (composition/clipTransform.ts); identity when plain',
  },
  { name: 'warpB', type: 'f32' },
  { name: 'warpTx', type: 'f32' },
  { name: 'warpC', type: 'f32' },
  { name: 'warpD', type: 'f32' },
  { name: 'warpTy', type: 'f32' },
  ...KEY_UNIFORM_FIELDS,
  {
    name: 'warpMask',
    type: 'f32',
    doc: '1: draw the quad below instead of dest and mask samples outside the picture (picture transform)',
  },
  { name: 'quadX', type: 'f32' },
  { name: 'quadY', type: 'f32' },
  { name: 'quadW', type: 'f32' },
  { name: 'quadH', type: 'f32' },
  { name: 'keySourceP3', type: 'f32', doc: '1: the source was imported as encoded Display P3; the key reads its sRGB view' },
  { name: '_pad1', type: 'f32' },
]);
