/**
 * Text fill WGSL — samples a glyph alpha mask and fills with a procedural color
 * only inside the glyph coverage. The mask is a full-resolution texture where
 * the alpha (or luminance) indicates glyph coverage (0..1).
 *
 * The host supplies a small uniform block and the mask texture. The shader
 * renders a full-target quad (or subrect) and writes premultiplied-alpha color.
 */

struct TextFillUniforms {
  time: f32,
  width: f32,
  height: f32,
  _pad0: f32,
  p0: f32,
  p1: f32,
  p2: f32,
  mode: f32,
  c0: vec4<f32>,
  c1: vec4<f32>,
  c2: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var maskSampler: sampler;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: TextFillUniforms;

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
  var out: VertexOutput;
  // Full target NDC mapping (dest is entire canvas for text layer target)
  let ndcX = mix(-1.0, 1.0, unit.x);
  let ndcY = mix(1.0, -1.0, unit.y);
  out.pos = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}

// ---- Fill implementations (selected by swapping the called function) ----

fn fill_gradient(uv: vec2<f32>, t: f32, p: vec4<f32>, c0: vec3<f32>, c1: vec3<f32>) -> vec3<f32> {
  // p0 = speed, p1 = angle (radians-ish)
  let speed = p.x;
  let angle = p.y;
  let dir = vec2<f32>(cos(angle), sin(angle));
  let proj = dot(uv - vec2<f32>(0.5), dir);
  let phase = fract(proj * 1.5 + t * speed * 0.5);
  return mix(c0, c1, smoothstep(0.0, 1.0, phase));
}

fn fill_plasma(uv: vec2<f32>, t: f32, p: vec4<f32>, c0: vec3<f32>, c1: vec3<f32>, c2: vec3<f32>) -> vec3<f32> {
  // p0 = scale, p1 = speed
  let scale = max(p.x, 0.1);
  let speed = p.y;
  let v = uv * scale;
  let a = sin(v.x * 3.2 + t * speed);
  let b = sin(v.y * 2.7 - t * speed * 0.8);
  let c = sin((v.x + v.y) * 4.0 + t * speed * 1.3);
  let n = (a + b + c) * 0.333 + 0.5;
  let w0 = 0.5 + 0.5 * sin(n * 6.28318);
  let w1 = 0.5 + 0.5 * sin(n * 6.28318 + 2.094);
  let w2 = 0.5 + 0.5 * sin(n * 6.28318 + 4.188);
  let col = c0 * w0 + c1 * w1 + c2 * w2;
  return clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let mask = textureSample(maskTex, maskSampler, in.uv);
  // Use max channel as coverage to be robust to how the 2D mask was drawn.
  let alpha = max(max(mask.r, mask.g), mask.b) * mask.a;

  if (alpha <= 0.0001) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let params = vec4<f32>(u.p0, u.p1, u.p2, u.mode);
  let mode = floor(u.mode + 0.5);
  var rgb: vec3<f32>;
  if (mode < 0.5) {
    rgb = fill_gradient(in.uv, u.time, params, u.c0.rgb, u.c1.rgb);
  } else {
    rgb = fill_plasma(in.uv, u.time, params, u.c0.rgb, u.c1.rgb, u.c2.rgb);
  }
  return vec4<f32>(rgb * alpha, alpha);
}
