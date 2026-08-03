@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var prevTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: NoiseReductionUniforms;

struct NoiseReductionUniforms {
  // vec4 0
  amount: f32,
  spatialStrength: f32,
  spatialRadius: f32,
  temporalStrength: f32,
  // vec4 1
  temporalMotionThreshold: f32,
  lumaOnly: f32,
  draft: f32,
  hasPrev: f32,
  // vec4 2
  texelSize: vec2<f32>,
  _pad0: f32,
  _pad1: f32,
  // vec4 3
  _pad2: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0),
  );
  var out: VertexOutput;
  out.pos = vec4<f32>(positions[idx], 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn rgbToYuv(c: vec3<f32>) -> vec3<f32> {
  let y = luma(c);
  let u = (c.b - y) * 0.565;
  let v = (c.r - y) * 0.713;
  return vec3<f32>(y, u, v);
}

fn yuvToRgb(yuv: vec3<f32>) -> vec3<f32> {
  let r = yuv.x + 1.403 * yuv.z;
  let g = yuv.x - 0.344 * yuv.y - 0.714 * yuv.z;
  let b = yuv.x + 1.770 * yuv.y;
  return vec3<f32>(r, g, b);
}

/// Edge-aware bilateral blur on luminance (5×5, radius-limited).
fn bilateralLuma(uv: vec2<f32>, centerRgb: vec3<f32>) -> f32 {
  let centerY = luma(centerRgb);
  let radius = clamp(u.spatialRadius, 0.0, 4.0);
  if (radius < 0.01 || u.spatialStrength <= 0.0) {
    return centerY;
  }

  // Draft mode: tighter spatial/range sigma for cheaper, softer NR.
  let draftScale = select(1.0, 0.65, u.draft > 0.5);
  let sigmaS = max(0.5, radius) * 0.55 * draftScale;
  let sigmaR = mix(0.04, 0.18, u.spatialStrength) * draftScale;
  let twoSigmaS2 = 2.0 * sigmaS * sigmaS;
  let twoSigmaR2 = 2.0 * sigmaR * sigmaR;

  var sum = 0.0;
  var wSum = 0.0;
  let rMax = i32(ceil(radius));

  for (var dy = -rMax; dy <= rMax; dy++) {
    for (var dx = -rMax; dx <= rMax; dx++) {
      let offset = vec2<f32>(f32(dx), f32(dy));
      let dist2 = dot(offset, offset);
      if (dist2 > radius * radius + 0.01) {
        continue;
      }
      let sampleUv = uv + offset * u.texelSize;
      let sampleRgb = textureSample(inputTex, inputSampler, sampleUv).rgb;
      let sampleY = luma(sampleRgb);
      let spatialW = exp(-dist2 / twoSigmaS2);
      let dyL = sampleY - centerY;
      let rangeW = exp(-(dyL * dyL) / twoSigmaR2);
      let w = spatialW * rangeW;
      sum += sampleY * w;
      wSum += w;
    }
  }

  if (wSum <= 1e-6) {
    return centerY;
  }
  let filtered = sum / wSum;
  return mix(centerY, filtered, clamp(u.spatialStrength, 0.0, 1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(inputTex, inputSampler, in.uv);
  let mixAmt = clamp(u.amount, 0.0, 1.0);
  if (mixAmt <= 0.0) {
    return src;
  }

  let center = src.rgb;
  var result = center;

  // Spatial NR on luma (optionally also soften chroma slightly when lumaOnly=0).
  let filteredY = bilateralLuma(in.uv, center);
  let yuv = rgbToYuv(center);
  if (u.lumaOnly > 0.5) {
    result = clamp(yuvToRgb(vec3<f32>(filteredY, yuv.y, yuv.z)), vec3<f32>(0.0), vec3<f32>(1.0));
  } else {
    // Mild chroma blur toward neighbor average when not luma-only.
    let neighbor = textureSample(inputTex, inputSampler, in.uv + u.texelSize).rgb;
    let neighborYuv = rgbToYuv(neighbor);
    let softU = mix(yuv.y, neighborYuv.y, u.spatialStrength * 0.35);
    let softV = mix(yuv.z, neighborYuv.z, u.spatialStrength * 0.35);
    result = clamp(yuvToRgb(vec3<f32>(filteredY, softU, softV)), vec3<f32>(0.0), vec3<f32>(1.0));
  }

  // Temporal blend with motion gate (no motion vectors in v1).
  if (u.hasPrev > 0.5 && u.temporalStrength > 0.0) {
    let prev = textureSample(prevTex, inputSampler, in.uv).rgb;
    let motion = abs(luma(result) - luma(prev));
    let thr = max(u.temporalMotionThreshold, 0.001);
    // Soft falloff: full blend below thr/2, none above thr.
    let gate = 1.0 - smoothstep(thr * 0.5, thr, motion);
    let tMix = clamp(u.temporalStrength * gate, 0.0, 1.0);
    if (u.lumaOnly > 0.5) {
      let rYuv = rgbToYuv(result);
      let pYuv = rgbToYuv(prev);
      let blendedY = mix(rYuv.x, pYuv.x, tMix);
      result = clamp(yuvToRgb(vec3<f32>(blendedY, rYuv.y, rYuv.z)), vec3<f32>(0.0), vec3<f32>(1.0));
    } else {
      result = mix(result, prev, tMix);
    }
  }

  let rgb = mix(src.rgb, result, mixAmt);
  return vec4<f32>(rgb, src.a);
}
