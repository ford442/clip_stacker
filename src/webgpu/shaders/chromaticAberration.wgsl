// Chromatic aberration — mirrors `chromaticAberrationPixel` in
// `src/utils/chromaticAberration.ts` (the tested reference).

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: ChromaticAberrationUniforms;

struct ChromaticAberrationUniforms {
  // vec4 0
  radialK: f32,
  dirX: f32,
  dirY: f32,
  spectral: f32,
  // vec4 1
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

const CA_SPECTRAL_TAPS: i32 = 7;
const CA_SPECTRAL_SIGMA: f32 = 0.45;

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

fn sampleRgb(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(inputTex, inputSampler, uv, 0.0).rgb;
}

/// Un-normalized (r, g, b) weights of tap t: red peaks at +1, green 0, blue −1.
fn spectralWeights(t: f32) -> vec3<f32> {
  let twoS2 = 2.0 * CA_SPECTRAL_SIGMA * CA_SPECTRAL_SIGMA;
  let d = vec3<f32>(t - 1.0, t, t + 1.0);
  return exp(-(d * d) / twoS2);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(inputTex, inputSampler, in.uv, 0.0);
  // Red is sampled at uv − o and blue at uv + o; radialK scales them about
  // the centre (lateral CA), dirX/dirY add a uniform shift.
  let o = u.radialK * (in.uv - vec2<f32>(0.5)) + vec2<f32>(u.dirX, u.dirY);
  if (abs(o.x) + abs(o.y) < 1e-7) {
    return src;
  }
  if (u.spectral < 0.5) {
    let r = sampleRgb(in.uv - o).r;
    let b = sampleRgb(in.uv + o).b;
    return vec4<f32>(r, src.g, b, src.a);
  }
  // Spectral fringe: each channel is a weighted spread along the offset whose
  // weights sum to 1, so flat areas are unchanged.
  var acc = vec3<f32>(0.0);
  var wSum = vec3<f32>(0.0);
  for (var i = 0; i < CA_SPECTRAL_TAPS; i++) {
    let t = -1.0 + 2.0 * f32(i) / f32(CA_SPECTRAL_TAPS - 1);
    let w = spectralWeights(t);
    acc += sampleRgb(in.uv - t * o) * w;
    wSum += w;
  }
  return vec4<f32>(acc / wSum, src.a);
}
