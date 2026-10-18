/**
 * The finishing preset field specs: one declaration per `FinishingSettings`
 * pass and field (type, range, description). `finishingPresets.ts` walks it
 * for strict validation and to generate the agent JSON Schema, so the two
 * cannot disagree. Adding a finishing pass or field means adding it here —
 * `finishingPresets.test.ts` fails otherwise.
 */

import type { FinishingSettings } from './finishing';
import { BUNDLED_LUT_PRESETS, COLOR_LUT_NONE } from './lut';
import { NOISE_REDUCTION_MAX_RADIUS } from './noiseReduction';
import { SHARPEN_RADIUS_MAX, SHARPEN_RADIUS_MIN } from './sharpen';
import { MAX_SECONDARY_GRADES } from './secondaryColor';
import { CURVE_MAX_POINTS, LEVELS_GAMMA_MAX, LEVELS_GAMMA_MIN } from './curves';

/** A custom .cube is embedded as text; keep presets within localStorage reach. */
export const FINISHING_PRESET_CUBE_MAX_CHARS = 4_000_000;

export type FieldSpec =
  | { type: 'boolean'; description: string }
  | { type: 'number'; min: number; max: number; description: string }
  | { type: 'enum'; values: readonly string[]; description: string }
  | { type: 'string'; maxLength: number; description: string }
  | { type: 'rgb'; min: number; max: number; description: string }
  | { type: 'object'; fields: Record<string, FieldSpec>; description: string }
  | { type: 'array'; items: FieldSpec; maxItems: number; description: string };

const bool = (description: string): FieldSpec => ({ type: 'boolean', description });
const num = (min: number, max: number, description: string): FieldSpec => ({
  type: 'number',
  min,
  max,
  description,
});
const oneOf = (values: readonly string[], description: string): FieldSpec => ({
  type: 'enum',
  values,
  description,
});
const rgb = (min: number, max: number, description: string): FieldSpec => ({
  type: 'rgb',
  min,
  max,
  description,
});
const obj = (fields: Record<string, FieldSpec>, description: string): FieldSpec => ({
  type: 'object',
  fields,
  description,
});

const ENABLED = bool('Turn the pass on. Omitted = off.');
const AMOUNT = num(0, 1, 'Strength / mix 0 (bypass) … 1 (full).');

const CURVE_POINTS = (channel: string): FieldSpec => ({
  type: 'array',
  maxItems: CURVE_MAX_POINTS,
  description: `${channel} curve knots, sorted by x, at least 2. [{x:0,y:0},{x:1,y:1}] = identity.`,
  items: obj(
    { x: num(0, 1, 'Input 0 … 1.'), y: num(0, 1, 'Output 0 … 1.') },
    'One curve knot.',
  ),
});

const SECONDARY_GRADE = obj(
  {
    enabled: ENABLED,
    maskType: oneOf(['hue', 'window', 'hue+window'], 'What selects the pixels.'),
    hueCenter: num(0, 360, 'Hue qualifier centre, degrees.'),
    hueWidth: num(0, 360, 'Hue qualifier width, degrees.'),
    hueSoftness: num(0, 180, 'Hue qualifier soft falloff, degrees.'),
    windowCenterX: num(0, 1, 'Power window centre X (0 … 1 of the frame).'),
    windowCenterY: num(0, 1, 'Power window centre Y (0 … 1 of the frame).'),
    windowWidth: num(0, 1, 'Power window width (0 … 1).'),
    windowHeight: num(0, 1, 'Power window height (0 … 1).'),
    windowRotation: num(-180, 180, 'Power window rotation, degrees.'),
    windowFeather: num(0, 1, 'Power window soft edge (0 … 1 of the radius).'),
    hueShift: num(-180, 180, 'Hue rotation inside the mask, degrees.'),
    satScale: num(0, 3, 'Saturation multiplier inside the mask (1 = neutral).'),
    lumOffset: num(-1, 1, 'Luminance offset inside the mask.'),
    satOffset: num(-1, 1, 'Saturation offset inside the mask.'),
    invertMask: bool('Adjust outside the mask instead of inside.'),
  },
  'One selective grade.',
);

/** Every pass of `FinishingSettings`, in chain order. */
export const FINISHING_PASS_SPECS: Record<keyof FinishingSettings, FieldSpec> = {
  noiseReduction: obj(
    {
      enabled: ENABLED,
      amount: AMOUNT,
      quality: oneOf(['standard', 'high', 'nlm'], 'Spatial tier: standard (fast), high (edge-aware), nlm (strongest).'),
      spatialStrength: num(0, 1, 'Spatial denoise strength.'),
      spatialRadius: num(0, NOISE_REDUCTION_MAX_RADIUS, 'Spatial radius in pixels.'),
      temporal: bool('Blend with the previous frame on static areas.'),
      temporalStrength: num(0, 1, 'Temporal blend strength.'),
      temporalMotionThreshold: num(0, 1, 'Luma change above which temporal blending stops (anti-ghost).'),
      lumaOnly: bool('Denoise luminance only and keep source colour (recommended).'),
      draft: bool('Cheaper kernel for live preview.'),
    },
    'Noise reduction — first pass.',
  ),
  primaryColor: obj(
    {
      enabled: ENABLED,
      amount: AMOUNT,
      exposure: num(-3, 3, 'Exposure, EV.'),
      contrast: num(0, 2, 'Contrast multiplier (1 = neutral).'),
      saturation: num(0, 2, 'Saturation (1 = neutral).'),
      temperature: num(-1, 1, 'Cool (−1) … warm (+1).'),
      tint: num(-1, 1, 'Magenta (−1) … green (+1).'),
      lift: rgb(-1, 1, 'Shadow offset per channel [r, g, b] (0 = neutral).'),
      gamma: rgb(0.1, 3, 'Midtone power per channel [r, g, b] (1 = neutral).'),
      gain: rgb(0, 2, 'Highlight multiply per channel [r, g, b] (1 = neutral).'),
    },
    'Primary colour balance (exposure, white balance, lift / gamma / gain).',
  ),
  curves: obj(
    {
      enabled: ENABLED,
      amount: AMOUNT,
      levels: obj(
        {
          inBlack: num(0, 1, 'Input black point.'),
          inWhite: num(0, 1, 'Input white point (must exceed inBlack).'),
          gamma: num(LEVELS_GAMMA_MIN, LEVELS_GAMMA_MAX, 'Midtone gamma (>1 brightens).'),
          outBlack: num(0, 1, 'Output black (lift for a matte look).'),
          outWhite: num(0, 1, 'Output white.'),
        },
        'Levels, applied before the curves.',
      ),
      curves: obj(
        {
          master: CURVE_POINTS('Master'),
          red: CURVE_POINTS('Red'),
          green: CURVE_POINTS('Green'),
          blue: CURVE_POINTS('Blue'),
        },
        'Monotone cubic curves: master, then per channel.',
      ),
    },
    'Curves & levels — after primary.',
  ),
  secondaryColor: obj(
    {
      enabled: ENABLED,
      amount: AMOUNT,
      grades: {
        type: 'array',
        items: SECONDARY_GRADE,
        maxItems: MAX_SECONDARY_GRADES,
        description: `Up to ${MAX_SECONDARY_GRADES} stacked selective grades.`,
      },
    },
    'Secondary / selective colour (hue qualifiers and power windows).',
  ),
  lut: obj(
    {
      enabled: ENABLED,
      lutId: oneOf(
        [COLOR_LUT_NONE, ...BUNDLED_LUT_PRESETS.map((p) => p.id), 'custom'],
        "Creative LUT: a bundled id, 'none', or 'custom' with customCubeText.",
      ),
      intensity: num(0, 1, 'LUT mix 0 … 1.'),
      amount: num(0, 1, 'Alias of intensity (ignored on load; intensity wins).'),
      customCubeText: {
        type: 'string',
        maxLength: FINISHING_PRESET_CUBE_MAX_CHARS,
        description: "Adobe .cube text, embedded, when lutId is 'custom'.",
      },
      customFileName: { type: 'string', maxLength: 256, description: 'Original .cube file name (display only).' },
    },
    'Creative 3D LUT.',
  ),
  sharpen: obj(
    {
      enabled: ENABLED,
      amount: AMOUNT,
      mode: oneOf(['classic', 'edge', 'multiscale'], 'classic unsharp, edge-aware (no halos), or multi-scale detail.'),
      radius: num(SHARPEN_RADIUS_MIN, SHARPEN_RADIUS_MAX, 'Radius in pixels.'),
      threshold: num(0, 1, 'Skip detail below this luma difference (keep ~0.01–0.05).'),
      midtoneDetail: num(0, 1, 'Midtone local contrast.'),
    },
    'Sharpening — after the LUT.',
  ),
  chromaticAberration: obj(
    {
      enabled: ENABLED,
      amount: num(0, 1, 'Fringe width (1 ≈ 0.8 % of the frame height).'),
      radial: num(0, 1, '1 = radial lens fringe, 0 = uniform shift along angle.'),
      angle: num(-360, 360, 'Direction of the uniform shift, degrees clockwise.'),
      spectral: bool('Soft spectral fringe (recommended).'),
    },
    'Chromatic aberration — after sharpen.',
  ),
  bloom: obj(
    {
      enabled: ENABLED,
      amount: num(0, 1, 'Glow strength.'),
      mode: oneOf(['bloom', 'lightWrap'], 'bloom (highlights glow) or lightWrap (light over dark edges).'),
      threshold: num(0, 1, 'Brightness where bloom starts.'),
      softness: num(0, 1, 'Soft knee around the threshold.'),
      radius: num(0, 1, 'Spread: 0 → 1 % … 1 → 25 % of the frame height.'),
      tint: rgb(0, 2, 'Glow colour multiplier [r, g, b] (1 = neutral).'),
    },
    'Bloom & glow — after chromatic aberration.',
  ),
  grain: obj(
    {
      enabled: ENABLED,
      amount: AMOUNT,
      quality: oneOf(['classic', 'film'], 'classic hash grain or film (blue-noise) grain.'),
      size: num(0, 1, 'Fine (0) … coarse (1).'),
      softness: num(0, 1, 'Bias grain toward the midtones.'),
      monochrome: bool('Monochrome grain (classic).'),
      monochromeBias: num(0, 1, 'Film: colour (0) … monochrome (1) grain.'),
      temporalCoherence: num(0, 1, 'Film: 0 = new grain every frame … 1 = slowly evolving.'),
      response: obj(
        {
          shadows: num(0, 2, 'Grain gain in the shadows.'),
          midtones: num(0, 2, 'Grain gain in the midtones.'),
          highlights: num(0, 2, 'Grain gain in the highlights.'),
        },
        'Film: grain response curve.',
      ),
      bloomAmount: num(0, 1, "Grain pass's own soft highlight bloom."),
      vignette: obj(
        {
          enabled: ENABLED,
          amount: num(0, 1, 'Edge darkening.'),
          midpoint: num(0, 1, 'Where the falloff starts.'),
          roundness: num(0, 1, 'Circular (0) … rectangular (1).'),
        },
        'Vignette.',
      ),
      halation: obj(
        {
          enabled: ENABLED,
          threshold: num(0, 1, 'Brightness threshold.'),
          amount: num(0, 1, 'Red halation strength.'),
          radius: num(0.5, 32, 'Blur radius in pixels.'),
        },
        'Film halation (red glow around highlights).',
      ),
    },
    'Film grain & optical — always last.',
  ),
};

export const FINISHING_PASS_KEYS = Object.keys(FINISHING_PASS_SPECS) as (keyof FinishingSettings)[];
