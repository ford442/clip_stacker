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

const directionParams: TransitionParamDef[] = [
  { key: 'dirX', label: 'Direction X', type: 'float', default: -1, min: -1, max: 1, step: 0.25 },
  { key: 'dirY', label: 'Direction Y', type: 'float', default: 0, min: -1, max: 1, step: 0.25 },
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
];

export const TRANSITION_REGISTRY: Readonly<Record<string, TransitionDef>> = Object.freeze(
  Object.fromEntries(REGISTRY_LIST.map((def) => [def.id, def])),
);

export const TRANSITION_IDS = REGISTRY_LIST.map((def) => def.id);

export function getTransitionDef(id: string): TransitionDef | undefined {
  return TRANSITION_REGISTRY[id];
}

export function isRegisteredTransitionType(type: string): boolean {
  return type !== 'none' && type in TRANSITION_REGISTRY;
}

export function getXfadeName(type: string): string {
  if (type === 'morph') return 'fade';
  return TRANSITION_REGISTRY[type]?.xfadeName ?? 'fade';
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
