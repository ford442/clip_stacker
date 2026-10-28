// Curves & levels — mirrors `curvesPixel` in `src/utils/curves.ts` (the
// tested reference). Levels → master curve → channel curve, mixed by amount.

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: CurvesUniforms;

const SCENE_LINEAR: bool = false;
const CURVE_MAX_POINTS: i32 = 16;

struct CurvesUniforms {
  // inBlack, inWhite, gamma, outBlack
  levels0: vec4<f32>,
  // outWhite, amount, pad, pad
  levels1: vec4<f32>,
  // knot counts: master, red, green, blue (0 = identity)
  counts: vec4<f32>,
  // 4 curves × 16 knots: (x, y, slope, pad)
  knots: array<vec4<f32>, 64>,
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

fn applyLevels(v: f32) -> f32 {
  let range = max(u.levels0.y - u.levels0.x, 1e-6);
  var n = (v - u.levels0.x) / range;
  if (SCENE_LINEAR) {
    n = max(n, 0.0);
  } else {
    n = clamp(n, 0.0, 1.0);
  }
  let g = pow(n, 1.0 / u.levels0.z);
  return u.levels0.w + g * (u.levels1.x - u.levels0.w);
}

/// Monotone cubic through knots [base, base + count): flat outside them,
/// Hermite inside (slopes precomputed on the CPU, Fritsch–Carlson).
fn evalCurveInRange(base: i32, count: i32, v: f32) -> f32 {
  let first = u.knots[base];
  if (v <= first.x) {
    return first.y;
  }
  let lastK = u.knots[base + count - 1];
  if (v >= lastK.x) {
    return lastK.y;
  }
  var i = 0;
  for (var j = 0; j < CURVE_MAX_POINTS - 2; j++) {
    if (i < count - 2 && v > u.knots[base + i + 1].x) {
      i++;
    }
  }
  let k0 = u.knots[base + i];
  let k1 = u.knots[base + i + 1];
  let h = k1.x - k0.x;
  let t = (v - k0.x) / h;
  let t2 = t * t;
  let t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * k0.y +
    (t3 - 2.0 * t2 + t) * h * k0.z +
    (-2.0 * t3 + 3.0 * t2) * k1.y +
    (t3 - t2) * h * k1.z;
}

fn evalCurve(channel: i32, count: i32, v: f32) -> f32 {
  if (count < 2) {
    return v;
  }
  let base = channel * CURVE_MAX_POINTS;
  // Scene-linear: continue past 1 with slope 1 so HDR highlights survive.
  if (SCENE_LINEAR && v > 1.0) {
    return evalCurveInRange(base, count, 1.0) + (v - 1.0);
  }
  return evalCurveInRange(base, count, v);
}

// Scene-linear (managed colour): curves and levels are display-referred
// tools, so grade in an extended sRGB encoding (1.0 stays 1.0, values above
// it stay above it) and decode back — a knot at 0.5 means mid-grey in both
// modes.
fn encodeSrgb(v: f32) -> f32 {
  let x = max(v, 0.0);
  return select(x * 12.92, 1.055 * pow(x, 1.0 / 2.4) - 0.055, x > 0.0031308);
}

fn decodeSrgb(v: f32) -> f32 {
  let x = max(v, 0.0);
  return select(x / 12.92, pow((x + 0.055) / 1.055, 2.4), x > 0.04045);
}

fn gradeChannel(v: f32, channel: i32, count: i32) -> f32 {
  var o = v;
  if (SCENE_LINEAR) {
    o = encodeSrgb(o);
  }
  o = applyLevels(o);
  o = evalCurve(0, i32(u.counts.x), o);
  o = evalCurve(channel, count, o);
  if (SCENE_LINEAR) {
    return decodeSrgb(o);
  }
  return clamp(o, 0.0, 1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(inputTex, inputSampler, in.uv, 0.0);
  let amount = u.levels1.y;
  if (amount <= 0.0) {
    return src;
  }
  let graded = vec3<f32>(
    gradeChannel(src.r, 1, i32(u.counts.y)),
    gradeChannel(src.g, 2, i32(u.counts.z)),
    gradeChannel(src.b, 3, i32(u.counts.w)),
  );
  return vec4<f32>(mix(src.rgb, graded, amount), src.a);
}
