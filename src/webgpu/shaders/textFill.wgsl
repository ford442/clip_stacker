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
  // generic params (shader-specific meaning)
  p0: f32,
  p1: f32,
  p2: f32,
  p3: f32,
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

fn fill_gradient(uv: vec2<f32>, t: f32, p: vec4<f32>) -> vec3<f32> {
  // p0 = speed, p1 = angle (radians-ish), p2 unused, p3 unused
  let speed = p.x;
  let angle = p.y;
  let dir = vec2<f32>(cos(angle), sin(angle));
  let proj = dot(uv - vec2<f32>(0.5), dir);
  let phase = fract(proj * 1.5 + t * speed * 0.5);
  let c1 = vec3<f32>(0.2, 0.6, 1.0);
  let c2 = vec3<f32>(1.0, 0.3, 0.7);
  return mix(c1, c2, smoothstep(0.0, 1.0, phase));
}

fn fill_plasma(uv: vec2<f32>, t: f32, p: vec4<f32>) -> vec3<f32> {
  // p0 = scale, p1 = speed
  let scale = max(p.x, 0.1);
  let speed = p.y;
  let v = uv * scale;
  let a = sin(v.x * 3.2 + t * speed);
  let b = sin(v.y * 2.7 - t * speed * 0.8);
  let c = sin((v.x + v.y) * 4.0 + t * speed * 1.3);
  let n = (a + b + c) * 0.333 + 0.5;
  // palette
  let col = vec3<f32>(
    0.5 + 0.5 * sin(n * 6.28318),
    0.5 + 0.5 * sin(n * 6.28318 + 2.094),
    0.5 + 0.5 * sin(n * 6.28318 + 4.188)
  );
  return clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn fill_color(uv: vec2<f32>, t: f32, p: vec4<f32>) -> vec3<f32> {
  // Fallback solid-ish (uses p0,p1,p2 as rgb-ish normalized 0..1)
  return clamp(vec3<f32>(p.x, p.y, p.z), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let mask = textureSample(maskTex, maskSampler, in.uv);
  // Use max channel as coverage to be robust to how the 2D mask was drawn.
  let alpha = max(max(mask.r, mask.g), mask.b) * mask.a;

  if (alpha <= 0.0001) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let params = vec4<f32>(u.p0, u.p1, u.p2, u.p3);
  // mode in p3: 0 gradient, 1 plasma
  let mode = floor(u.p3 + 0.5);
  var rgb: vec3<f32>;
  if (mode < 0.5) {
    rgb = fill_gradient(in.uv, u.time, params);
  } else {
    rgb = fill_plasma(in.uv, u.time, params);
  }
  return vec4<f32>(rgb * alpha, alpha);
}
