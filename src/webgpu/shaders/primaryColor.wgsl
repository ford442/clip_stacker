@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: PrimaryColorUniforms;

struct PrimaryColorUniforms {
  // vec4 0
  amount: f32,
  exposure: f32,
  contrast: f32,
  saturation: f32,
  // vec4 1
  temperature: f32,
  tint: f32,
  contrastPivot: f32,
  _pad0: f32,
  // vec4 2
  lift: vec3<f32>,
  _pad1: f32,
  // vec4 3
  gamma: vec3<f32>,
  _pad2: f32,
  // vec4 4
  gain: vec3<f32>,
  _pad3: f32,
  // vec4 5
  _pad4: vec4<f32>,
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

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

/// Diagonal WB scale from temperature (blue↔yellow) and tint (magenta↔green).
fn whiteBalance(c: vec3<f32>, temperature: f32, tint: f32) -> vec3<f32> {
  let rScale = 1.0 + temperature * 0.18;
  let gScale = 1.0 + tint * 0.18;
  let bScale = 1.0 - temperature * 0.18;
  return c * vec3<f32>(rScale, gScale, bScale);
}

/// DaVinci-style lift / gamma / gain (ASC-CDL-like).
/// Neutral: lift=0, gamma=1, gain=1 → identity.
fn liftGammaGain(c: vec3<f32>, lift: vec3<f32>, gamma: vec3<f32>, gain: vec3<f32>) -> vec3<f32> {
  let lifted = c * gain + lift;
  let safeGamma = max(gamma, vec3<f32>(0.001));
  return pow(max(lifted, vec3<f32>(0.0)), 1.0 / safeGamma);
}

fn applyContrast(c: vec3<f32>, contrast: f32, pivot: f32) -> vec3<f32> {
  return (c - pivot) * contrast + pivot;
}

fn applySaturation(c: vec3<f32>, saturation: f32) -> vec3<f32> {
  let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  return mix(vec3<f32>(luma), c, saturation);
}

fn gradeLinear(c: vec3<f32>) -> vec3<f32> {
  var rgb = c * exp2(u.exposure);
  rgb = whiteBalance(rgb, u.temperature, u.tint);
  rgb = liftGammaGain(rgb, u.lift, u.gamma, u.gain);
  rgb = applyContrast(rgb, u.contrast, u.contrastPivot);
  rgb = applySaturation(rgb, u.saturation);
  return rgb;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(inputTex, inputSampler, in.uv);
  let mixAmt = clamp(u.amount, 0.0, 1.0);
  if (mixAmt <= 0.0) {
    return src;
  }

  let linearIn = srgbToLinear(src.rgb);
  let gradedLinear = gradeLinear(linearIn);
  let graded = clamp(linearToSrgb(gradedLinear), vec3<f32>(0.0), vec3<f32>(1.0));
  let rgb = mix(src.rgb, graded, mixAmt);
  return vec4<f32>(rgb, src.a);
}
