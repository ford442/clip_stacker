// Color transforms for the managed pipeline. Mode numbers match ColorXformMode
// in src/utils/colorManagement.ts. Matrices arrive as uniform rows so this
// file does not hard-code a second copy of the D65 primaries.
//
// f32 variant. colorManagementPass.ts builds an f16 variant of applyMatrix
// when the device adopted shader-f16.

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: ColorXformUniforms;

struct ColorXformUniforms {
  mode: f32,
  referenceWhiteNits: f32,
  _pad0: f32,
  _pad1: f32,
  row0: vec4<f32>,
  row1: vec4<f32>,
  row2: vec4<f32>,
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

fn applyMatrix(row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(row0.xyz, c), dot(row1.xyz, c), dot(row2.xyz, c));
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

const PQ_M1: f32 = 0.1593017578125;
const PQ_M2: f32 = 78.84375;
const PQ_C1: f32 = 0.8359375;
const PQ_C2: f32 = 18.8515625;
const PQ_C3: f32 = 18.6875;

fn nitsToPq(nits: vec3<f32>) -> vec3<f32> {
  let y = max(nits, vec3<f32>(0.0)) / 10000.0;
  let ym = pow(y, vec3<f32>(PQ_M1));
  let code = pow((vec3<f32>(PQ_C1) + vec3<f32>(PQ_C2) * ym) / (vec3<f32>(1.0) + vec3<f32>(PQ_C3) * ym), vec3<f32>(PQ_M2));
  return select(code, vec3<f32>(0.0), nits <= vec3<f32>(0.0));
}

fn pqToNits(code: vec3<f32>) -> vec3<f32> {
  let e = pow(max(code, vec3<f32>(0.0)), vec3<f32>(1.0 / PQ_M2));
  let num = max(e - vec3<f32>(PQ_C1), vec3<f32>(0.0));
  let den = max(vec3<f32>(PQ_C2) - vec3<f32>(PQ_C3) * e, vec3<f32>(1e-6));
  let nits = pow(num / den, vec3<f32>(1.0 / PQ_M1)) * 10000.0;
  return select(nits, vec3<f32>(0.0), code <= vec3<f32>(0.0));
}

fn pqToScene(code: vec3<f32>) -> vec3<f32> {
  return pqToNits(code) / max(u.referenceWhiteNits, 1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(inputTex, inputSampler, in.uv);
  let mode = u.mode;

  // 0 — encoded Rec.709 → scene-linear Rec.2020
  if (mode < 0.5) {
    let linear = srgbToLinear(max(src.rgb, vec3<f32>(0.0)));
    let rec2020 = applyMatrix(u.row0, u.row1, u.row2, linear);
    return vec4<f32>(rec2020, src.a);
  }

  // 1 — Rec.2020 linear → Rec.709 OETF (clip above diffuse white)
  if (mode < 1.5) {
    let lin = applyMatrix(u.row0, u.row1, u.row2, max(src.rgb, vec3<f32>(0.0)));
    return vec4<f32>(linearToSrgb(clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0))), src.a);
  }

  // 2 — Rec.2020 linear → Display P3 + sRGB OETF
  if (mode < 2.5) {
    let lin = applyMatrix(u.row0, u.row1, u.row2, max(src.rgb, vec3<f32>(0.0)));
    return vec4<f32>(linearToSrgb(clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0))), src.a);
  }

  // 3 — Rec.2020 linear → PQ codes (1.0 linear = reference white)
  if (mode < 3.5) {
    let nits = max(src.rgb, vec3<f32>(0.0)) * max(u.referenceWhiteNits, 1.0);
    return vec4<f32>(nitsToPq(nits), src.a);
  }

  // 4 — copy display-referred codes (also the HDR10 rgba8 quantize)
  if (mode < 4.5) {
    return src;
  }

  // 5 — encoded Display P3 → encoded Rec.709 (sRGB canvas fallback)
  if (mode < 5.5) {
    let lin = srgbToLinear(max(src.rgb, vec3<f32>(0.0)));
    let rec709 = applyMatrix(u.row0, u.row1, u.row2, lin);
    return vec4<f32>(linearToSrgb(clamp(rec709, vec3<f32>(0.0), vec3<f32>(1.0))), src.a);
  }

  // 6 — PQ codes → extended sRGB (float canvas only)
  if (mode < 6.5) {
    let scene = pqToScene(src.rgb);
    let lin = applyMatrix(u.row0, u.row1, u.row2, max(scene, vec3<f32>(0.0)));
    return vec4<f32>(linearToSrgb(max(lin, vec3<f32>(0.0))), src.a);
  }

  // 7 — PQ codes → SDR sRGB, clipping above the reference white
  let scene = pqToScene(src.rgb);
  let lin = applyMatrix(u.row0, u.row1, u.row2, max(scene, vec3<f32>(0.0)));
  return vec4<f32>(linearToSrgb(clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0))), src.a);
}
