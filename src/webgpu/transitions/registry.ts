import type { ClipTransition } from '../../types';
import {
  CUSTOM_TRANSITION_TYPE,
  DEFAULT_CUSTOM_EXPRESSION,
  buildCustomTransitionDef,
  getCustomTransitionDef,
  isCustomTransitionId,
  registerCustomTransition,
} from './customShader';
import type { TransitionDef, TransitionParamDef } from './types';

const dissolveBody = `
  result = mix(sampleFrom(uv), sampleTo(uv), u.progress);
`;

const wipeLeftBody = `
  let edge = smoothstep(u.progress - 0.02, u.progress + 0.02, uv.x);
  result = mix(sampleTo(uv), sampleFrom(uv), edge);
`;

const wipeRightBody = `
  let edge = smoothstep(u.progress - 0.02, u.progress + 0.02, 1.0 - uv.x);
  result = mix(sampleTo(uv), sampleFrom(uv), edge);
`;

const wipeUpBody = `
  let edge = smoothstep(u.progress - 0.02, u.progress + 0.02, uv.y);
  result = mix(sampleTo(uv), sampleFrom(uv), edge);
`;

const wipeDownBody = `
  let edge = smoothstep(u.progress - 0.02, u.progress + 0.02, 1.0 - uv.y);
  result = mix(sampleTo(uv), sampleFrom(uv), edge);
`;

const crossZoomBody = `
  let zoom = 1.0 + u.progress * 0.4;
  let center = vec2<f32>(0.5, 0.5);
  let fromUv = (uv - center) * zoom + center;
  let toUv = (uv - center) / max(zoom, 0.001) + center;
  result = mix(sampleFrom(fromUv), sampleTo(toUv), u.progress);
`;

const swirlBody = `
  let center = vec2<f32>(0.5, 0.5);
  let offset = uv - center;
  let angle = u.progress * 6.28318;
  let c = cos(angle);
  let s = sin(angle);
  let rotated = vec2<f32>(offset.x * c - offset.y * s, offset.x * s + offset.y * c) + center;
  let fromColor = sampleFrom(rotated);
  let toColor = sampleTo(uv);
  result = mix(fromColor, toColor, u.progress);
`;

const pixelizeBody = `
  let squares = mix(1.0, 48.0, u.progress);
  let pixelUv = floor(uv * squares) / squares + 0.5 / squares;
  result = mix(sampleFrom(pixelUv), sampleTo(pixelUv), u.progress);
`;

const crosshatchBody = `
  let fromColor = sampleFrom(uv);
  let toColor = sampleTo(uv);
  let density = 40.0;
  let line = step(0.5, fract((uv.x + uv.y) * density + u.progress * 4.0));
  result = mix(fromColor, toColor, line * u.progress + (1.0 - u.progress) * u.progress);
`;

const rippleBody = `
  let center = vec2<f32>(0.5, 0.5);
  let dist = distance(uv, center);
  let wave = sin(dist * 30.0 - u.progress * 12.0) * 0.04 * (1.0 - u.progress);
  let fromUv = uv + normalize(uv - center + vec2<f32>(0.0001)) * wave;
  result = mix(sampleFrom(fromUv), sampleTo(uv), u.progress);
`;

const glitchBody = `
  let blockY = floor(uv.y * 24.0);
  let seed = sin(blockY * 12.9898 + u.progress * 78.233) * 43758.5453;
  let jitter = fract(seed) * 0.12 * (1.0 - u.progress);
  let fromUv = vec2<f32>(uv.x + jitter, uv.y);
  let toUv = vec2<f32>(uv.x - jitter * 0.5, uv.y);
  let band = step(fract(seed * 0.13), u.progress * 0.85);
  result = mix(sampleFrom(fromUv), sampleTo(toUv), band);
`;

const doomBody = `
  let fromColor = sampleFrom(uv);
  let toColor = sampleTo(uv);
  let melt = uv.y + (1.0 - uv.x) * u.progress * 0.35;
  let bar = step(melt, 1.0 - u.progress * 0.15);
  let meltedFrom = sampleFrom(vec2<f32>(uv.x, min(uv.y + u.progress * 0.25, 1.0)));
  result = mix(meltedFrom, toColor, bar * u.progress + (1.0 - bar) * u.progress);
`;

const morphBody = `
  let center = vec2<f32>(0.5, 0.5);
  let d = distance(uv, center);
  let radius = u.progress * 0.75;
  let feather = 0.08;
  let mask = smoothstep(radius - feather, radius + feather, d);
  result = mix(sampleTo(uv), sampleFrom(uv), mask);
`;

const directionalBody = `
  let dir = vec2<f32>(u.custom0, u.custom1);
  let len = max(length(dir), 0.001);
  let n = dir / len;
  let proj = dot(uv - vec2<f32>(0.5), n) + 0.5;
  let edge = smoothstep(u.progress - 0.02, u.progress + 0.02, proj);
  result = mix(sampleTo(uv), sampleFrom(uv), edge);
`;

const filmBurnBody = `
  let fromColor = sampleFrom(uv);
  let toColor = sampleTo(uv);
  // Bloom rises and falls across the overlap, peaking just past the midpoint
  // so the join reads as a film splice rather than a symmetric flash.
  let shaped = pow(clamp(u.progress, 0.0, 1.0), 0.7);
  let bloom = pow(sin(shaped * 3.14159265), 1.5);
  let vignette = 1.0 - distance(uv, vec2<f32>(0.5, 0.5)) * 0.9;
  let burn = clamp(bloom * max(vignette, 0.0) * u.custom0, 0.0, 1.0);
  let base = mix(fromColor, toColor, smoothstep(0.35, 0.8, u.progress));
  // Orange/yellow oversaturation first, then a whiteout at the burn peak.
  let ember = vec4<f32>(1.0, 0.66, 0.22, 1.0);
  let scorched = mix(base, ember, burn);
  result = mix(scorched, vec4<f32>(1.0, 1.0, 1.0, 1.0), burn * burn * clamp(u.custom1, 0.0, 1.0));
`;

const lumaWipeBody = `
  // Boundary comes from the mask texture, never from clip content, so an HDR
  // source can't push the threshold outside 0-1.
  let luma = sampleMaskLuma(uv);
  let softness = max(u.custom0, 0.001);
  let lo = u.progress * (1.0 + softness) - softness;
  let edge = smoothstep(lo, lo + softness, luma);
  result = mix(sampleTo(uv), sampleFrom(uv), edge);
`;

const radialIrisBody = `
  let center = vec2<f32>(u.custom0, u.custom1);
  let aspect = max(u.resolutionX, 1.0) / max(u.resolutionY, 1.0);
  let scaled = vec2<f32>(aspect, 1.0);
  let d = length((uv - center) * scaled);
  // Farthest corner from the iris centre — guarantees full coverage at 1.0.
  let corner = max(center, vec2<f32>(1.0, 1.0) - center);
  let maxRadius = length(corner * scaled);
  let feather = max(u.custom2, 0.0001);
  let radius = u.progress * (maxRadius + feather * 2.0);
  let mask = smoothstep(radius - feather, radius + feather, d);
  result = mix(sampleTo(uv), sampleFrom(uv), mask);
`;

const chromaShiftBody = `
  let amount = max(u.custom0, 0.0) * sin(clamp(u.progress, 0.0, 1.0) * 3.14159265);
  let slices = max(u.custom1, 1.0);
  let blockY = floor(uv.y * slices);
  // Quantized time keeps the jitter blocky rather than a smooth slide.
  let seed = sin(blockY * 12.9898 + floor(u.progress * 24.0) * 78.233) * 43758.5453;
  let slice = (fract(seed) - 0.5) * amount;
  let scanline = (fract(uv.y * slices * 8.0) - 0.5) * amount * 0.2;
  let base = vec2<f32>(uv.x + slice + scanline, uv.y);
  let redUv = vec2<f32>(base.x + amount * 0.35, base.y);
  let blueUv = vec2<f32>(base.x - amount * 0.35, base.y);
  let fromSplit = vec4<f32>(
    sampleFrom(redUv).r,
    sampleFrom(base).g,
    sampleFrom(blueUv).b,
    1.0,
  );
  let toSplit = vec4<f32>(
    sampleTo(redUv).r,
    sampleTo(base).g,
    sampleTo(blueUv).b,
    1.0,
  );
  result = mix(fromSplit, toSplit, smoothstep(0.35, 0.65, u.progress));
`;

const motionBlurPullBody = `
  let ease = sin(clamp(u.progress, 0.0, 1.0) * 3.14159265);
  let strength = max(u.custom0, 0.0) * ease;
  // TAP_COUNT override — clamped to the shader's accumulation budget.
  let taps = i32(clamp(u.custom1, 1.0, 8.0));
  let slide = u.custom2;
  let denom = max(f32(taps - 1), 1.0);
  var fromSum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var toSum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  for (var i: i32 = 0; i < taps; i = i + 1) {
    let smear = (f32(i) / denom - 0.5) * strength;
    fromSum = fromSum + sampleFrom(vec2<f32>(uv.x + smear + u.progress * slide, uv.y));
    toSum = toSum + sampleTo(vec2<f32>(uv.x + smear - (1.0 - u.progress) * slide, uv.y));
  }
  let inv = 1.0 / f32(taps);
  result = mix(fromSum * inv, toSum * inv, smoothstep(0.25, 0.75, u.progress));
`;

const directionParams: TransitionParamDef[] = [
  { key: 'dirX', label: 'Direction X', type: 'float', default: -1, min: -1, max: 1, step: 0.25 },
  { key: 'dirY', label: 'Direction Y', type: 'float', default: 0, min: -1, max: 1, step: 0.25 },
];

const filmBurnParams: TransitionParamDef[] = [
  { key: 'intensity', label: 'Burn intensity', type: 'float', default: 0.9, min: 0, max: 2, step: 0.1 },
  { key: 'whiteout', label: 'Whiteout', type: 'float', default: 0.8, min: 0, max: 1, step: 0.05 },
];

const lumaWipeParams: TransitionParamDef[] = [
  { key: 'softness', label: 'Edge softness', type: 'float', default: 0.15, min: 0.01, max: 1, step: 0.01 },
];

const radialIrisParams: TransitionParamDef[] = [
  { key: 'centerX', label: 'Center X', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05 },
  { key: 'centerY', label: 'Center Y', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05 },
  { key: 'feather', label: 'Feather', type: 'float', default: 0.06, min: 0.001, max: 0.5, step: 0.01 },
];

const chromaShiftParams: TransitionParamDef[] = [
  { key: 'amount', label: 'Shift amount', type: 'float', default: 0.06, min: 0, max: 0.3, step: 0.01 },
  { key: 'slices', label: 'Scanline slices', type: 'float', default: 24, min: 1, max: 120, step: 1 },
];

const motionBlurParams: TransitionParamDef[] = [
  { key: 'blur', label: 'Blur length', type: 'float', default: 0.12, min: 0, max: 0.5, step: 0.01 },
  { key: 'taps', label: 'Sample taps', type: 'float', default: 6, min: 1, max: 8, step: 1 },
  { key: 'pull', label: 'Pull distance', type: 'float', default: 0.25, min: 0, max: 1, step: 0.05 },
];

const REGISTRY_LIST: TransitionDef[] = [
  {
    id: 'dissolve',
    label: 'Dissolve',
    description: 'Classic crossfade between clips',
    xfadeName: 'fade',
    wgslBody: dissolveBody,
  },
  {
    id: 'motion',
    label: 'Motion blend',
    description: 'Smooth left wipe (legacy motion preset)',
    xfadeName: 'smoothleft',
    wgslBody: wipeLeftBody,
  },
  {
    id: 'wipeLeft',
    label: 'Wipe left',
    description: 'Reveal incoming clip from the right',
    xfadeName: 'wiperight',
    wgslBody: wipeLeftBody,
  },
  {
    id: 'wipeRight',
    label: 'Wipe right',
    description: 'Reveal incoming clip from the left',
    xfadeName: 'wipeleft',
    wgslBody: wipeRightBody,
  },
  {
    id: 'wipeUp',
    label: 'Wipe up',
    description: 'Vertical wipe upward',
    xfadeName: 'slideup',
    wgslBody: wipeUpBody,
  },
  {
    id: 'wipeDown',
    label: 'Wipe down',
    description: 'Vertical wipe downward',
    xfadeName: 'slidedown',
    wgslBody: wipeDownBody,
  },
  {
    id: 'crossZoom',
    label: 'Cross zoom',
    description: 'Zoom crossfade inspired by GL-Transitions',
    xfadeName: 'zoomin',
    wgslBody: crossZoomBody,
  },
  {
    id: 'swirl',
    label: 'Swirl',
    description: 'Rotating swirl between clips',
    xfadeName: 'circlecrop',
    wgslBody: swirlBody,
  },
  {
    id: 'pixelize',
    label: 'Pixelize',
    description: 'Pixelation dissolve',
    xfadeName: 'pixelize',
    wgslBody: pixelizeBody,
  },
  {
    id: 'crosshatch',
    label: 'Crosshatch',
    description: 'Diagonal hatch reveal',
    xfadeName: 'diagtl',
    wgslBody: crosshatchBody,
  },
  {
    id: 'ripple',
    label: 'Ripple',
    description: 'Radial ripple distortion',
    xfadeName: 'radial',
    wgslBody: rippleBody,
  },
  {
    id: 'glitch',
    label: 'Glitch',
    description: 'Blocky horizontal glitch bands',
    xfadeName: 'hlslice',
    wgslBody: glitchBody,
  },
  {
    id: 'doom',
    label: 'Doom melt',
    description: 'Melted screen transition',
    xfadeName: 'vertopen',
    wgslBody: doomBody,
  },
  {
    id: 'radialReveal',
    label: 'Radial reveal',
    description: 'Radial mask reveal',
    xfadeName: 'circleopen',
    wgslBody: morphBody,
  },
  {
    id: 'directional',
    label: 'Directional warp',
    description: 'Custom-direction wipe',
    xfadeName: 'smoothleft',
    wgslBody: directionalBody,
    params: directionParams,
  },
  {
    id: 'filmBurn',
    label: 'Film burn',
    description: 'Orange bleach bloom that whites out over the splice',
    xfadeName: 'fadewhite',
    wgslBody: filmBurnBody,
    params: filmBurnParams,
  },
  {
    id: 'lumaWipe',
    label: 'Luma wipe',
    description: 'Wipe boundary driven by the mask texture luminance',
    xfadeName: 'dissolve',
    wgslBody: lumaWipeBody,
    params: lumaWipeParams,
  },
  {
    id: 'radialIris',
    label: 'Radial iris',
    description: 'Circular iris grows from a chosen center point',
    xfadeName: 'circleopen',
    wgslBody: radialIrisBody,
    params: radialIrisParams,
  },
  {
    id: 'chromaShift',
    label: 'Glitch chromashift',
    description: 'RGB channel split with sliced scanline offsets',
    xfadeName: 'hlslice',
    wgslBody: chromaShiftBody,
    params: chromaShiftParams,
  },
  {
    id: 'motionBlurPull',
    label: 'Motion blur pull',
    description: 'Horizontal smear pull-off built from accumulation taps',
    xfadeName: 'smoothleft',
    wgslBody: motionBlurPullBody,
    params: motionBlurParams,
  },
  buildCustomTransitionDef(DEFAULT_CUSTOM_EXPRESSION, CUSTOM_TRANSITION_TYPE),
];

export const TRANSITION_REGISTRY: Readonly<Record<string, TransitionDef>> = Object.freeze(
  Object.fromEntries(REGISTRY_LIST.map((def) => [def.id, def])),
);

export const TRANSITION_IDS = REGISTRY_LIST.map((def) => def.id);

export function getTransitionDef(id: string): TransitionDef | undefined {
  const builtin = TRANSITION_REGISTRY[id];
  if (builtin) return builtin;
  // `custom#<hash>` variants live in the runtime map, not the static registry.
  return isCustomTransitionId(id) ? getCustomTransitionDef(id) : undefined;
}

export function isRegisteredTransitionType(type: string): boolean {
  if (type === 'none') return false;
  return type in TRANSITION_REGISTRY || getTransitionDef(type) !== undefined;
}

export function getXfadeName(type: string): string {
  if (type === 'morph') return 'fade';
  return getTransitionDef(type)?.xfadeName ?? 'fade';
}

/**
 * Shader id to render `transition` with. Custom transitions carry their WGSL
 * on the clip, so it is registered here (idempotently, keyed by content hash)
 * and rendered under the resulting `custom#<hash>` id. Everything else renders
 * under its own registry id.
 */
export function resolveTransitionShaderId(transition: {
  type: string;
  customShader?: string;
}): string {
  if (transition.type !== CUSTOM_TRANSITION_TYPE) return transition.type;
  if (!transition.customShader) return CUSTOM_TRANSITION_TYPE;
  return registerCustomTransition(transition.customShader);
}

/** True when this transition's shader body is user-authored WGSL. */
export function isCustomTransition(
  transition: Pick<ClipTransition, 'type'> | undefined,
): boolean {
  return transition?.type === CUSTOM_TRANSITION_TYPE;
}

/** UI options for TransitionEditor (excludes 'none'). */
export function listTransitionOptions(): Array<{
  value: string;
  label: string;
  description: string;
  params?: TransitionParamDef[];
}> {
  return REGISTRY_LIST.map(({ id, label, description, params }) => ({
    value: id,
    label,
    description,
    params,
  }));
}

export function defaultTransitionParams(def: TransitionDef): Record<string, number> {
  if (!def.params) return {};
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

/** Map custom param keys to uniform slots custom0..custom3. */
export function resolveCustomUniforms(
  def: TransitionDef | undefined,
  params: Record<string, number> | undefined,
): [number, number, number, number] {
  if (!def?.params?.length) return [0, 0, 0, 0];
  const values = def.params.map(
    (p) => params?.[p.key] ?? p.default,
  );
  return [
    values[0] ?? 0,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 0,
  ];
}
