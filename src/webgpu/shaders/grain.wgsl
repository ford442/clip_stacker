@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: GrainUniforms;
@group(0) @binding(3) var blurredTex: texture_2d<f32>;

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
  blurAxis: f32,
  _pad1: f32,
  // vec4 4 — film quality mode (all zero = classic, the pre-film behaviour)
  quality: f32,
  monochromeBias: f32,
  temporalCoherence: f32,
  _pad2: f32,
  // vec4 5 — film response curve (grain gain at luma 0 / 0.5 / 1)
  responseShadows: f32,
  responseMidtones: f32,
  responseHighlights: f32,
  _pad3: f32,
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

// ---------------------------------------------------------------------------
// Film quality grain — mirrors `src/utils/filmGrain.ts` (the tested reference).

const FILM_GRAIN_NORM: f32 = 2.0;
const FILM_GRAIN_RMS: f32 = 0.046;
const FILM_GRAIN_OCTAVE2_SCALE: f32 = 2.17;
const FILM_GRAIN_OCTAVE2_WEIGHT: f32 = 0.5;
const FILM_GRAIN_MAX_HOLD_FRAMES: f32 = 12.0;

/// PCG4D (Jarzynski & Olano 2020): wrapping u32 maths, identical on every GPU.
fn pcg4d(seed: vec4<u32>) -> vec4<u32> {
  var v = seed * 1664525u + 1013904223u;
  v.x += v.y * v.w;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v.w += v.y * v.z;
  v = v ^ (v >> vec4<u32>(16u));
  v.x += v.y * v.w;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v.w += v.y * v.z;
  return v;
}

/// White lattice value in [-1, 1) per channel: (mono, r, g, b).
fn grainLattice(cell: vec2<i32>, frame: u32, octave: u32) -> vec4<f32> {
  let h = pcg4d(vec4<u32>(bitcast<vec2<u32>>(cell), frame, octave));
  return vec4<f32>(h) * (2.0 / 4294967296.0) - 1.0;
}

/// One octave of quintic-interpolated blue-noise lattice values. Each corner
/// is white noise minus its 4-neighbour mean (zero DC), so the 2×2 corners
/// need the 12 lattice points of a 4×4 block without its corners.
fn blueValueNoise(p: vec2<f32>, frame: u32, octave: u32) -> vec4<f32> {
  let i = vec2<i32>(floor(p));
  let f = fract(p);
  let c00 = grainLattice(i, frame, octave);
  let c10 = grainLattice(i + vec2<i32>(1, 0), frame, octave);
  let c01 = grainLattice(i + vec2<i32>(0, 1), frame, octave);
  let c11 = grainLattice(i + vec2<i32>(1, 1), frame, octave);
  let cm0 = grainLattice(i + vec2<i32>(-1, 0), frame, octave);
  let cm1 = grainLattice(i + vec2<i32>(-1, 1), frame, octave);
  let c20 = grainLattice(i + vec2<i32>(2, 0), frame, octave);
  let c21 = grainLattice(i + vec2<i32>(2, 1), frame, octave);
  let c0m = grainLattice(i + vec2<i32>(0, -1), frame, octave);
  let c1m = grainLattice(i + vec2<i32>(1, -1), frame, octave);
  let c02 = grainLattice(i + vec2<i32>(0, 2), frame, octave);
  let c12 = grainLattice(i + vec2<i32>(1, 2), frame, octave);
  let b00 = c00 - 0.25 * (cm0 + c10 + c0m + c01);
  let b10 = c10 - 0.25 * (c00 + c20 + c1m + c11);
  let b01 = c01 - 0.25 * (cm1 + c11 + c00 + c02);
  let b11 = c11 - 0.25 * (c01 + c21 + c10 + c12);
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(b00, b10, w.x), mix(b01, b11, w.x), w.y);
}

/// Two-octave field for one integer frame key, unit RMS per channel.
fn filmGrainField(p: vec2<f32>, frame: u32) -> vec4<f32> {
  let o1 = blueValueNoise(p, frame, 0u);
  let o2 = blueValueNoise(
    p * FILM_GRAIN_OCTAVE2_SCALE + vec2<f32>(17.3, 5.9),
    frame,
    1u,
  );
  return (o1 + o2 * FILM_GRAIN_OCTAVE2_WEIGHT) * FILM_GRAIN_NORM;
}

/// Unit-RMS RGB grain. Size is relative to frame height and grains are round
/// on any aspect, so preview and export at different resolutions match.
fn filmGrainRgb(uv: vec2<f32>) -> vec3<f32> {
  let cells = mix(720.0, 160.0, clamp(u.size, 0.0, 1.0));
  let aspect = u.texelSize.y / max(u.texelSize.x, 1e-9);
  let p = vec2<f32>(uv.x * aspect, uv.y) * cells;

  // Stateless temporal coherence: cross-fade two frame-keyed fields with a
  // variance-preserving weight (no previous-frame texture, so nothing smears
  // and any frame index reproduces exactly). Coherence 0 → weight is 0.
  let hold = 1.0 + clamp(u.temporalCoherence, 0.0, 1.0) * (FILM_GRAIN_MAX_HOLD_FRAMES - 1.0);
  let t = max(floor(u.frameSeed), 0.0) / hold;
  let keyF = floor(t);
  let weight = t - keyF;
  let key = u32(keyF);
  var g = filmGrainField(p, key);
  if (weight > 0.0) {
    let next = filmGrainField(p, key + 1u);
    let norm = inverseSqrt((1.0 - weight) * (1.0 - weight) + weight * weight);
    g = mix(g, next, weight) * norm;
  }

  let b = clamp(u.monochromeBias, 0.0, 1.0);
  let monoNorm = inverseSqrt((1.0 - b) * (1.0 - b) + b * b);
  return mix(g.yzw, g.xxx, b) * monoNorm;
}

/// Response curve through (0, shadows), (0.5, midtones), (1, highlights).
fn grainResponse(y: f32) -> f32 {
  if (y < 0.5) {
    return mix(u.responseShadows, u.responseMidtones, smoothstep(0.0, 1.0, y / 0.5));
  }
  return mix(u.responseMidtones, u.responseHighlights, smoothstep(0.0, 1.0, (y - 0.5) / 0.5));
}

/// Soft midtone weight — peaking near 0.5 when softness is high.
fn midtoneGrainWeight(y: f32, softness: f32) -> f32 {
  let mid = smoothstep(0.08, 0.28, y) * (1.0 - smoothstep(0.72, 0.92, y));
  return mix(1.0, mid, clamp(softness, 0.0, 1.0));
}

/// 1D Gaussian matching the previous 17×17 isotropic kernel (separable).
fn sampleBlurred1d(uv: vec2<f32>, axis: vec2<f32>) -> vec3<f32> {
  let radius = clamp(max(u.halationRadius, 4.0), 0.5, 32.0);
  let sigma = max(radius * 0.4, 0.5);
  let twoSigma2 = 2.0 * sigma * sigma;
  let limit = i32(min(ceil(radius), 8.0));

  var sum = vec3<f32>(0.0);
  var wSum = 0.0;
  for (var i = -8; i <= 8; i++) {
    if (abs(i) > limit) {
      continue;
    }
    let d2 = f32(i * i);
    let w = exp(-d2 / twoSigma2);
    let sampleUv = uv + axis * f32(i) * u.texelSize;
    let sample = textureSampleLevel(inputTex, inputSampler, sampleUv, 0.0);
    sum += sample.rgb * w;
    wSum += w;
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
fn fs_blur(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(inputTex, inputSampler, in.uv, 0.0);
  let axis = select(vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), u.blurAxis > 0.5);
  let rgb = sampleBlurred1d(in.uv, axis);
  return vec4<f32>(rgb, src.a);
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

  // Soft highlight bloom + red-channel halation (shared pre-blurred texture).
  if (halationAmt > 0.0 || bloomAmt > 0.0) {
    let blurred = textureSampleLevel(blurredTex, inputSampler, in.uv, 0.0).rgb;
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
  if (amount > 0.0 && u.quality > 0.5) {
    let weight = midtoneGrainWeight(y, u.softness) * max(grainResponse(y), 0.0);
    color = color + filmGrainRgb(in.uv) * amount * weight * FILM_GRAIN_RMS;
  } else if (amount > 0.0) {
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
