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
  // Per-side layer warps: the same inverse 2x3 the preview shader's
  // applyLayerWarp() uses (stabilization composed with the authored picture
  // transform, centred normalized UV). Identity when the clip is neither
  // stabilized nor transformed, so a warped clip stays warped through a
  // crossfade instead of snapping back for its length.
  fromWarpA: f32,
  fromWarpB: f32,
  fromWarpTx: f32,
  fromWarpC: f32,
  fromWarpD: f32,
  fromWarpTy: f32,
  toWarpA: f32,
  toWarpB: f32,
  toWarpTx: f32,
  toWarpC: f32,
  toWarpD: f32,
  toWarpTy: f32,
  // 1 when that side has an authored picture transform: samples landing
  // outside the picture are transparent rather than clamped to its edge.
  fromWarpMask: f32,
  toWarpMask: f32,
  _pad0: f32,
  _pad1: f32,
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

// Same maths as applyLayerWarp() in preview.wgsl — one warp, not a second one.
fn applyLayerWarp(uv: vec2<f32>, m0: vec3<f32>, m1: vec3<f32>) -> vec2<f32> {
  let centered = uv - vec2<f32>(0.5, 0.5);
  return vec2<f32>(
    m0.x * centered.x + m0.y * centered.y + m0.z,
    m1.x * centered.x + m1.y * centered.y + m1.z,
  ) + vec2<f32>(0.5, 0.5);
}

// Hard-edged (no fwidth): bodies may call the samplers from non-uniform
// control flow, where derivatives are not allowed.
fn insidePicture(warped: vec2<f32>, mask: f32) -> f32 {
  let inside = all(warped >= vec2<f32>(0.0)) && all(warped <= vec2<f32>(1.0));
  return select(1.0, select(0.0, 1.0, inside), mask > 0.5);
}

fn sampleFrom(uv: vec2<f32>) -> vec4<f32> {
  let warped = applyLayerWarp(
    uv,
    vec3<f32>(u.fromWarpA, u.fromWarpB, u.fromWarpTx),
    vec3<f32>(u.fromWarpC, u.fromWarpD, u.fromWarpTy),
  );
  let mapped = warped * vec2<f32>(u.fromUvScaleX, u.fromUvScaleY)
    + vec2<f32>(u.fromUvOffsetX, u.fromUvOffsetY);
  return textureSampleBaseClampToEdge(fromTexture, videoSampler, mapped)
    * insidePicture(warped, u.fromWarpMask);
}

fn sampleTo(uv: vec2<f32>) -> vec4<f32> {
  let warped = applyLayerWarp(
    uv,
    vec3<f32>(u.toWarpA, u.toWarpB, u.toWarpTx),
    vec3<f32>(u.toWarpC, u.toWarpD, u.toWarpTy),
  );
  let mapped = warped * vec2<f32>(u.toUvScaleX, u.toUvScaleY)
    + vec2<f32>(u.toUvOffsetX, u.toUvOffsetY);
  return textureSampleBaseClampToEdge(toTexture, videoSampler, mapped)
    * insidePicture(warped, u.toWarpMask);
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
export const TRANSITION_UNIFORM_FLOATS = 36;

/** First slot of the outgoing clip's layer warp affine. */
export const FROM_WARP_UNIFORM_OFFSET = 20;

/** First slot of the incoming clip's layer warp affine. */
export const TO_WARP_UNIFORM_OFFSET = 26;

/** `fromWarpMask`, then `toWarpMask`. */
export const WARP_MASK_UNIFORM_OFFSET = 32;
