@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: GrainUniforms;

struct GrainUniforms {
  // vec4 0
  amount: f32,
  size: f32,
  softness: f32,
  monochrome: f32,
  // vec4 1
  vignetteAmount: f32,
  vignetteMidpoint: f32,
  vignetteRoundness: f32,
  frameSeed: f32,
  // vec4 2
  halationAmount: f32,
  halationThreshold: f32,
  halationRadius: f32,
  bloomAmount: f32,
  // vec4 3
  texelSize: vec2<f32>,
  _pad0: f32,
  _pad1: f32,
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

/// Integer hash → [0, 1) — stable across devices for the same cell + frameSeed.
fn hash21(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, vec3<f32>(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
  return fract((p3.x + p3.y) * p3.z);
}

fn hash23(p: vec2<f32>) -> vec3<f32> {
  return vec3<f32>(
    hash21(p),
    hash21(p + vec2<f32>(19.19, 7.7)),
    hash21(p + vec2<f32>(3.3, 41.41)),
  );
}

/// Soft midtone weight — peaking near 0.5 when softness is high.
fn midtoneGrainWeight(y: f32, softness: f32) -> f32 {
  let mid = smoothstep(0.08, 0.28, y) * (1.0 - smoothstep(0.72, 0.92, y));
  return mix(1.0, mid, clamp(softness, 0.0, 1.0));
}

fn sampleBlurred(uv: vec2<f32>, radiusPx: f32) -> vec3<f32> {
  let radius = clamp(radiusPx, 0.5, 32.0);
  let sigma = max(radius * 0.4, 0.5);
  let twoSigma2 = 2.0 * sigma * sigma;
  let limit = i32(min(ceil(radius), 8.0));

  var sum = vec3<f32>(0.0);
  var wSum = 0.0;
  for (var dy = -8; dy <= 8; dy++) {
    for (var dx = -8; dx <= 8; dx++) {
      if (abs(dx) > limit || abs(dy) > limit) {
        continue;
      }
      let d2 = f32(dx * dx + dy * dy);
      let w = exp(-d2 / twoSigma2);
      let sampleUv = uv + vec2<f32>(f32(dx), f32(dy)) * u.texelSize;
      let sample = textureSampleLevel(inputTex, inputSampler, sampleUv, 0.0);
      sum += sample.rgb * w;
      wSum += w;
    }
  }
  if (wSum <= 1e-6) {
    return textureSampleLevel(inputTex, inputSampler, uv, 0.0).rgb;
  }
  return sum / wSum;
}

fn vignetteFactor(uv: vec2<f32>) -> f32 {
  let amount = clamp(u.vignetteAmount, 0.0, 1.0);
  if (amount <= 1e-5) {
    return 1.0;
  }
  let mid = clamp(u.vignetteMidpoint, 0.05, 0.95);
  let roundness = clamp(u.vignetteRoundness, 0.0, 1.0);
  let centered = uv * 2.0 - 1.0;
  // Mix Euclidean (circular) and Chebyshev-ish (more square) distance.
  let circ = length(centered);
  let sq = max(abs(centered.x), abs(centered.y));
  let dist = mix(circ, sq, roundness * 0.65);
  let edge = smoothstep(mid, 1.15, dist);
  return 1.0 - edge * amount;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(inputTex, inputSampler, in.uv, 0.0);
  let amount = clamp(u.amount, 0.0, 1.0);
  let vignetteAmt = clamp(u.vignetteAmount, 0.0, 1.0);
  let halationAmt = clamp(u.halationAmount, 0.0, 1.0);
  let bloomAmt = clamp(u.bloomAmount, 0.0, 1.0);

  if (amount <= 0.0 && vignetteAmt <= 0.0 && halationAmt <= 0.0 && bloomAmt <= 0.0) {
    return src;
  }

  var color = src.rgb;
  let y = luma(color);

  // Soft highlight bloom + red-channel halation (shared blur).
  if (halationAmt > 0.0 || bloomAmt > 0.0) {
    let blurred = sampleBlurred(in.uv, max(u.halationRadius, 4.0));
    let bright = max(luma(blurred) - clamp(u.halationThreshold, 0.0, 1.0), 0.0);
    let brightMask = smoothstep(0.0, 0.35, bright);

    // Soft bloom: add blurred highlights.
    color = color + blurred * bloomAmt * brightMask * 0.55;

    // Halation: red-biased add-back (subtle lens softening via blur mix).
    let redBloom = vec3<f32>(blurred.r * 1.15, blurred.g * 0.35, blurred.b * 0.2);
    color = color + redBloom * halationAmt * brightMask;

    // Mild overall soft when optical bloom is active (subtle lens softening).
    let softMix = (halationAmt * 0.12 + bloomAmt * 0.18) * brightMask;
    color = mix(color, blurred, clamp(softMix, 0.0, 0.35));
  }

  // Procedural grain — seeded by integer export/preview frame index.
  if (amount > 0.0) {
    // size 0 (fine) → denser cells; size 1 (coarse) → larger grain.
    let cells = mix(720.0, 160.0, clamp(u.size, 0.0, 1.0));
    let cell = floor(in.uv * cells);
    let seed = vec2<f32>(u.frameSeed * 0.137, u.frameSeed * 0.913);
    let n = hash23(cell + seed);
    var grain = n * 2.0 - 1.0;
    if (u.monochrome > 0.5) {
      let g = hash21(cell + seed) * 2.0 - 1.0;
      grain = vec3<f32>(g, g, g);
    }
    let weight = midtoneGrainWeight(y, u.softness);
    // ~±8% luma swing at amount=1.
    color = color + grain * amount * weight * 0.08;
  }

  color = color * vignetteFactor(in.uv);
  color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(color, src.a);
}
