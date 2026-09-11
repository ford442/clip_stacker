import type { TransitionDef } from './types';

/** Shared WGSL preamble for all transition shaders (GL-Transitions style). */
const TRANSITION_PREAMBLE = `
struct TransitionUniforms {
  progress: f32,
  resolutionX: f32,
  resolutionY: f32,
  fromUvScaleX: f32,
  fromUvScaleY: f32,
  fromUvOffsetX: f32,
  fromUvOffsetY: f32,
  toUvScaleX: f32,
  toUvScaleY: f32,
  toUvOffsetX: f32,
  toUvOffsetY: f32,
  destX: f32,
  destY: f32,
  destW: f32,
  destH: f32,
  custom0: f32,
  custom1: f32,
  custom2: f32,
  custom3: f32,
  // Per-side camera-shake corrections (inverse-warp 2x3 affines in normalized
  // UV, centred on the frame). Identity when the clip is not stabilized, so a
  // stabilized clip stays steady through a crossfade instead of popping.
  fromStabA: f32,
  fromStabB: f32,
  fromStabTx: f32,
  fromStabC: f32,
  fromStabD: f32,
  fromStabTy: f32,
  toStabA: f32,
  toStabB: f32,
  toStabTx: f32,
  toStabC: f32,
  toStabD: f32,
  toStabTy: f32,
};

struct VertexOutput {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var fromTexture: texture_external;
@group(0) @binding(2) var toTexture: texture_external;
@group(0) @binding(3) var<uniform> u: TransitionUniforms;
@group(0) @binding(4) var maskTexture: texture_2d<f32>;

fn stabilize(uv: vec2<f32>, m0: vec3<f32>, m1: vec3<f32>) -> vec2<f32> {
  let centered = uv - vec2<f32>(0.5, 0.5);
  return vec2<f32>(
    m0.x * centered.x + m0.y * centered.y + m0.z,
    m1.x * centered.x + m1.y * centered.y + m1.z,
  ) + vec2<f32>(0.5, 0.5);
}

fn sampleFrom(uv: vec2<f32>) -> vec4<f32> {
  let steady = stabilize(
    uv,
    vec3<f32>(u.fromStabA, u.fromStabB, u.fromStabTx),
    vec3<f32>(u.fromStabC, u.fromStabD, u.fromStabTy),
  );
  let mapped = steady * vec2<f32>(u.fromUvScaleX, u.fromUvScaleY)
    + vec2<f32>(u.fromUvOffsetX, u.fromUvOffsetY);
  return textureSampleBaseClampToEdge(fromTexture, videoSampler, mapped);
}

fn sampleTo(uv: vec2<f32>) -> vec4<f32> {
  let steady = stabilize(
    uv,
    vec3<f32>(u.toStabA, u.toStabB, u.toStabTx),
    vec3<f32>(u.toStabC, u.toStabD, u.toStabTy),
  );
  let mapped = steady * vec2<f32>(u.toUvScaleX, u.toUvScaleY)
    + vec2<f32>(u.toUvOffsetX, u.toUvOffsetY);
  return textureSampleBaseClampToEdge(toTexture, videoSampler, mapped);
}

fn sampleMask(uv: vec2<f32>) -> vec4<f32> {
  return textureSample(maskTexture, videoSampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)));
}

/**
 * Rec.709 luminance of the wipe mask, clamped to 0-1.
 *
 * The boundary is driven by the mask rather than by clip content so an HDR
 * (>1.0) source can never push the wipe threshold out of range.
 */
fn sampleMaskLuma(uv: vec2<f32>) -> f32 {
  let c = sampleMask(uv);
  return clamp(dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
}

fn transitionEffect(uv: vec2<f32>) -> vec4<f32> {
  var result: vec4<f32>;
`;

const TRANSITION_POSTAMBLE = `
  return result;
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
  var unitPositions = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0),
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
  );

  let unit = unitPositions[idx];
  let ndcLeft = u.destX * 2.0 - 1.0;
  let ndcRight = (u.destX + u.destW) * 2.0 - 1.0;
  let ndcTop = 1.0 - u.destY * 2.0;
  let ndcBottom = 1.0 - (u.destY + u.destH) * 2.0;
  let ndcX = mix(ndcLeft, ndcRight, unit.x);
  let ndcY = mix(ndcBottom, ndcTop, unit.y);

  var out: VertexOutput;
  out.pos = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return transitionEffect(in.uv);
}
`;

export function buildTransitionShader(def: TransitionDef): string {
  return `${TRANSITION_PREAMBLE}\n${def.wgslBody}\n${TRANSITION_POSTAMBLE}`;
}

/** Number of f32 values in TransitionUniforms (must match WGSL struct). */
export const TRANSITION_UNIFORM_FLOATS = 32;

/** First slot of the outgoing clip's stabilization affine. */
export const FROM_STAB_UNIFORM_OFFSET = 20;

/** First slot of the incoming clip's stabilization affine. */
export const TO_STAB_UNIFORM_OFFSET = 26;
