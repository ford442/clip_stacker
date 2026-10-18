@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var prevTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: NoiseReductionUniforms;

const SCENE_LINEAR: bool = false;

fn clip01(c: vec3<f32>) -> vec3<f32> {
  if (SCENE_LINEAR) {
    return c;
  }
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

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
  // 0 = standard (original bilateral), 1 = high (guided bilateral), 2 = nlm.
  quality: f32,
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

// ---------------------------------------------------------------------------
// Quality tiers — mirror `src/utils/denoiseReference.ts` (the tested
// reference). They read exact texels with textureLoad (clamp-to-edge), so
// they need no uniform control flow and match the CPU reference.

const NR_HIGH_RADIUS_SCALE: f32 = 1.5;
const NR_HIGH_MAX_REACH: f32 = 4.5;
const NR_HIGH_CUTOFF_MIN: f32 = 0.05;
const NR_HIGH_CUTOFF_MAX: f32 = 0.3;
const NR_NLM_H_MIN: f32 = 0.02;
const NR_NLM_H_MAX: f32 = 0.11;
const NR_NLM_MAX_SEARCH: i32 = 3;

fn loadRgb(p: vec2<i32>) -> vec3<f32> {
  let maxP = vec2<i32>(textureDimensions(inputTex)) - vec2<i32>(1);
  return textureLoad(inputTex, clamp(p, vec2<i32>(0), maxP), 0).rgb;
}

/// Tukey biweight: 1 at d = 0, 0 at |d| >= 1 — a hard, smooth edge stop.
fn tukey(d: f32) -> f32 {
  let t = min(abs(d), 1.0);
  let s = 1.0 - t * t;
  return s * s;
}

/// High: guided bilateral. Range weights compare each tap with a 3×3
/// sigma-filtered guide (not the noisy centre pixel) through a Tukey edge
/// stop, over 1.5× the radius (capped at 4.5 px, ≤ 69 dense taps). Chroma reuses
/// the luma weights. Returns filtered RGB.
fn highRgb(pix: vec2<i32>, center: vec3<f32>) -> vec3<f32> {
  let centerY = luma(center);
  let radius = clamp(u.spatialRadius, 0.0, 4.0);
  let strength = clamp(u.spatialStrength, 0.0, 1.0);
  if (radius < 0.01 || u.spatialStrength <= 0.0) {
    return center;
  }
  let cutoff = mix(NR_HIGH_CUTOFF_MIN, NR_HIGH_CUTOFF_MAX, strength);

  var gSum = 0.0;
  var gW = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let v = luma(loadRgb(pix + vec2<i32>(i, j)));
      let w = tukey((v - centerY) / cutoff);
      gSum += v * w;
      gW += w;
    }
  }
  let guide = gSum / gW;

  let reach = select(
    min(radius * NR_HIGH_RADIUS_SCALE, NR_HIGH_MAX_REACH),
    radius,
    u.draft > 0.5,
  );
  let steps = i32(floor(reach + 1e-4));
  let sigmaS = max(0.5, reach) * 0.5;
  let twoSigmaS2 = 2.0 * sigmaS * sigmaS;

  var sum = vec3<f32>(0.0);
  var wSum = 0.0;
  for (var j = -steps; j <= steps; j++) {
    for (var i = -steps; i <= steps; i++) {
      let off = vec2<i32>(i, j);
      let dist2 = f32(off.x * off.x + off.y * off.y);
      if (dist2 > reach * reach + 0.01) {
        continue;
      }
      let s = loadRgb(pix + off);
      let w = exp(-dist2 / twoSigmaS2) * tukey((luma(s) - guide) / cutoff);
      sum += s * w;
      wSum += w;
    }
  }
  if (wSum <= 1e-6) {
    return center;
  }
  return mix(center, sum / wSum, strength);
}

/// NLM: non-local means over a (2S+1)² window with 3×3 luma patches read from
/// one cached (2S+3)² block (≤ 81 + 48 fetches). Buades' noise offset, and the
/// centre weighted like its best neighbour. Returns filtered RGB.
fn nlmRgb(pix: vec2<i32>, center: vec3<f32>) -> vec3<f32> {
  let radius = clamp(u.spatialRadius, 0.0, 4.0);
  let strength = clamp(u.spatialStrength, 0.0, 1.0);
  if (radius < 0.01 || u.spatialStrength <= 0.0) {
    return center;
  }
  let search = clamp(i32(round(radius)), 1, NR_NLM_MAX_SEARCH);
  let n = search + 1;
  let side = 2 * n + 1;
  var block: array<f32, 81>;
  for (var j = -n; j <= n; j++) {
    for (var i = -n; i <= n; i++) {
      block[(j + n) * side + (i + n)] = luma(loadRgb(pix + vec2<i32>(i, j)));
    }
  }
  let h = mix(NR_NLM_H_MIN, NR_NLM_H_MAX, strength);
  let invH2 = 1.0 / (h * h);

  var sum = vec3<f32>(0.0);
  var wSum = 0.0;
  var wMax = 0.0;
  for (var j = -search; j <= search; j++) {
    for (var i = -search; i <= search; i++) {
      if (i == 0 && j == 0) {
        continue;
      }
      var d2 = 0.0;
      for (var pj = -1; pj <= 1; pj++) {
        for (var pi = -1; pi <= 1; pi++) {
          let a = block[(n + pj) * side + (n + pi)];
          let b = block[(n + j + pj) * side + (n + i + pi)];
          d2 += (a - b) * (a - b);
        }
      }
      d2 = d2 / 9.0;
      let w = exp(-max(d2 * invH2 - 0.5, 0.0));
      sum += loadRgb(pix + vec2<i32>(i, j)) * w;
      wSum += w;
      wMax = max(wMax, w);
    }
  }
  let wCenter = select(1.0, wMax, wMax > 1e-6);
  sum += center * wCenter;
  wSum += wCenter;
  return mix(center, sum / wSum, strength);
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
  let yuv = rgbToYuv(center);

  if (u.quality > 0.5) {
    let pix = vec2<i32>(floor(in.pos.xy));
    var f: vec3<f32>;
    if (u.quality > 1.5) {
      f = nlmRgb(pix, center);
    } else {
      f = highRgb(pix, center);
    }
    // Filter in RGB with luma-guided weights; Luma only adds just the luma
    // change, so source chroma is kept exactly (no lossy YUV round trip).
    if (u.lumaOnly > 0.5) {
      f = center + vec3<f32>(luma(f) - yuv.x);
    }
    result = clip01(f);
  } else {
    // Spatial NR on luma (optionally also soften chroma slightly when lumaOnly=0).
    let filteredY = bilateralLuma(in.uv, center);
    if (u.lumaOnly > 0.5) {
      result = clip01(yuvToRgb(vec3<f32>(filteredY, yuv.y, yuv.z)));
    } else {
      // Mild chroma blur toward neighbor average when not luma-only.
      let neighbor = textureSample(inputTex, inputSampler, in.uv + u.texelSize).rgb;
      let neighborYuv = rgbToYuv(neighbor);
      let softU = mix(yuv.y, neighborYuv.y, u.spatialStrength * 0.35);
      let softV = mix(yuv.z, neighborYuv.z, u.spatialStrength * 0.35);
      result = clip01(yuvToRgb(vec3<f32>(filteredY, softU, softV)));
    }
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
      result = clip01(yuvToRgb(vec3<f32>(blendedY, rYuv.y, rYuv.z)));
    } else {
      result = mix(result, prev, tMix);
    }
  }

  let rgb = mix(src.rgb, result, mixAmt);
  return vec4<f32>(rgb, src.a);
}
