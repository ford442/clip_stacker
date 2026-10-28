// Bloom / light wrap pyramid — mirrors `bloomImage` in `src/utils/bloom.ts`
// (the tested reference). Entry points: fs_prefilter (frame → level 0),
// fs_down (level k → k+1), fs_up (tent of level k+1, added onto level k by
// the pipeline's additive blend) and fs_composite (glow over the frame).

@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: BloomUniforms;
@group(0) @binding(3) var baseTex: texture_2d<f32>;

const SCENE_LINEAR: bool = false;
const BLOOM_LINEAR_CLAMP: f32 = 64.0;

struct BloomUniforms {
  // vec4 0: source texel size, threshold, knee
  srcTexel: vec2<f32>,
  threshold: f32,
  knee: f32,
  // vec4 1: upsample weight, mode (0 bloom / 1 light wrap), gain, norm
  weight: f32,
  mode: f32,
  gain: f32,
  norm: f32,
  // vec4 2: tint, pad
  tint: vec3<f32>,
  _pad: f32,
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

fn tap(uv: vec2<f32>, dx: f32, dy: f32) -> vec3<f32> {
  return textureSampleLevel(srcTex, linearSampler, uv + vec2<f32>(dx, dy) * u.srcTexel, 0.0).rgb;
}

/// 13-tap downsample (COD: Advanced Warfare): five 2×2 groups, the centre
/// one weighted 0.5. With `karis`, each group is also weighted 1 / (1 + luma)
/// so one hot pixel cannot flicker the whole glow.
fn downsample13(uv: vec2<f32>, karis: bool) -> vec3<f32> {
  let a = tap(uv, -2.0, -2.0);
  let b = tap(uv, 0.0, -2.0);
  let c = tap(uv, 2.0, -2.0);
  let d = tap(uv, -1.0, -1.0);
  let e = tap(uv, 1.0, -1.0);
  let f = tap(uv, -2.0, 0.0);
  let g = tap(uv, 0.0, 0.0);
  let h = tap(uv, 2.0, 0.0);
  let i = tap(uv, -1.0, 1.0);
  let j = tap(uv, 1.0, 1.0);
  let k = tap(uv, -2.0, 2.0);
  let l = tap(uv, 0.0, 2.0);
  let m = tap(uv, 2.0, 2.0);
  let g0 = (d + e + i + j) * 0.25;
  let g1 = (a + b + f + g) * 0.25;
  let g2 = (b + c + g + h) * 0.25;
  let g3 = (f + g + k + l) * 0.25;
  let g4 = (g + h + l + m) * 0.25;
  var w = vec4<f32>(0.125);
  var w0 = 0.5;
  if (karis) {
    w0 = w0 / (1.0 + luma(g0));
    w = w / (vec4<f32>(1.0) + vec4<f32>(luma(g1), luma(g2), luma(g3), luma(g4)));
  }
  let sum = g0 * w0 + g1 * w.x + g2 * w.y + g3 * w.z + g4 * w.w;
  return sum / (w0 + w.x + w.y + w.z + w.w);
}

/// Soft-knee threshold on the max channel (Karis / Unity).
fn softThreshold(c: vec3<f32>) -> vec3<f32> {
  if (u.threshold <= 0.0) {
    return c;
  }
  let br = max(c.r, max(c.g, c.b));
  var rq = clamp(br - u.threshold + u.knee, 0.0, 2.0 * u.knee);
  rq = rq * rq / (4.0 * u.knee + 1e-5);
  let contrib = max(rq, br - u.threshold) / max(br, 1e-5);
  return c * contrib;
}

/// 9-tap tent over the source texels.
fn tent9(uv: vec2<f32>) -> vec3<f32> {
  var sum = vec3<f32>(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let w = select(1.0, 2.0, dx == 0) * select(1.0, 2.0, dy == 0);
      sum += tap(uv, f32(dx), f32(dy)) * (w / 16.0);
    }
  }
  return sum;
}

@fragment
fn fs_prefilter(in: VertexOutput) -> @location(0) vec4<f32> {
  let c = softThreshold(downsample13(in.uv, true));
  let cap = select(1.0, BLOOM_LINEAR_CLAMP, SCENE_LINEAR);
  return vec4<f32>(min(c, vec3<f32>(cap)), 1.0);
}

@fragment
fn fs_down(in: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(downsample13(in.uv, false), 1.0);
}

@fragment
fn fs_up(in: VertexOutput) -> @location(0) vec4<f32> {
  // Added onto the destination level by the pipeline's one + one blend.
  return vec4<f32>(tent9(in.uv) * u.weight, 0.0);
}

@fragment
fn fs_composite(in: VertexOutput) -> @location(0) vec4<f32> {
  let base = textureSampleLevel(baseTex, linearSampler, in.uv, 0.0);
  let b = tent9(in.uv) * u.norm;
  let src = base.rgb;
  if (u.mode > 0.5) {
    // Light wrap: pull the surrounding light over pixels darker than it.
    let lb = luma(b);
    let ls = luma(src);
    let w = clamp((lb - ls) / max(lb, 1e-4), 0.0, 1.0) * u.gain;
    var o = mix(src, b * u.tint, w);
    if (!SCENE_LINEAR) {
      o = clamp(o, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    return vec4<f32>(o, base.a);
  }
  let g = b * u.tint * u.gain;
  if (SCENE_LINEAR) {
    return vec4<f32>(src + g, base.a);
  }
  // Screen on the display-referred chain, so highlights roll off.
  let s = clamp(src, vec3<f32>(0.0), vec3<f32>(1.0));
  let gc = clamp(g, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(vec3<f32>(1.0) - (vec3<f32>(1.0) - s) * (vec3<f32>(1.0) - gc), base.a);
}
