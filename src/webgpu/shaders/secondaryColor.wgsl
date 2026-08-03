@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: SecondaryColorUniforms;

struct SecondaryGradeUniforms {
  // vec4 0
  enabled: f32,
  maskMode: f32, // 0=hue, 1=window, 2=hue+window
  invert: f32,
  _pad0: f32,
  // vec4 1 — hue params as turns (0–1 of the circle; width/softness in same units)
  hueCenter: f32,
  hueWidth: f32,
  hueSoftness: f32,
  _pad1: f32,
  // vec4 2
  winCenterX: f32,
  winCenterY: f32,
  winWidth: f32,
  winHeight: f32,
  // vec4 3
  winRotation: f32, // radians
  winFeather: f32,
  _pad2: f32,
  _pad3: f32,
  // vec4 4
  hueShift: f32, // turns
  satScale: f32,
  lumOffset: f32,
  satOffset: f32,
};

struct SecondaryColorUniforms {
  amount: f32,
  gradeCount: f32,
  _padA: f32,
  _padB: f32,
  grades: array<SecondaryGradeUniforms, 3>,
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

fn rgbToHsl(c: vec3<f32>) -> vec3<f32> {
  let maxc = max(max(c.r, c.g), c.b);
  let minc = min(min(c.r, c.g), c.b);
  let l = (maxc + minc) * 0.5;
  let d = maxc - minc;
  if (d < 1e-6) {
    return vec3<f32>(0.0, 0.0, l);
  }
  let s = select(d / (2.0 - maxc - minc), d / (maxc + minc), l > 0.5);
  var h: f32;
  if (maxc == c.r) {
    h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b);
  } else if (maxc == c.g) {
    h = (c.b - c.r) / d + 2.0;
  } else {
    h = (c.r - c.g) / d + 4.0;
  }
  h = h / 6.0;
  return vec3<f32>(h, s, l);
}

fn hue2rgb(p: f32, q: f32, t_in: f32) -> f32 {
  var t = t_in;
  if (t < 0.0) { t = t + 1.0; }
  if (t > 1.0) { t = t - 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hslToRgb(hsl: vec3<f32>) -> vec3<f32> {
  let h = hsl.x;
  let s = hsl.y;
  let l = hsl.z;
  if (s <= 1e-6) {
    return vec3<f32>(l, l, l);
  }
  let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
  let p = 2.0 * l - q;
  return vec3<f32>(
    hue2rgb(p, q, h + 1.0 / 3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0 / 3.0),
  );
}

/// Circular hue distance in turns (0 … 0.5).
fn hueDistance(a: f32, b: f32) -> f32 {
  let d = abs(a - b);
  return min(d, 1.0 - d);
}

fn hueMask(h: f32, center: f32, width: f32, softness: f32) -> f32 {
  let halfWidth = max(width, 0.0) * 0.5;
  if (halfWidth <= 0.0) {
    return 0.0;
  }
  let soft = max(softness, 1e-4);
  let dist = hueDistance(h, center);
  return 1.0 - smoothstep(halfWidth - soft, halfWidth + soft, dist);
}

fn windowMask(uv: vec2<f32>, g: SecondaryGradeUniforms) -> f32 {
  let halfSize = max(vec2<f32>(g.winWidth, g.winHeight) * 0.5, vec2<f32>(1e-4));
  let p = uv - vec2<f32>(g.winCenterX, g.winCenterY);
  let c = cos(g.winRotation);
  let s = sin(g.winRotation);
  let pr = vec2<f32>(p.x * c + p.y * s, -p.x * s + p.y * c);
  let q = pr / halfSize;
  let d = length(q);
  let feather = max(g.winFeather, 1e-4);
  return 1.0 - smoothstep(1.0 - feather, 1.0 + feather, d);
}

fn evaluateMask(h: f32, uv: vec2<f32>, g: SecondaryGradeUniforms) -> f32 {
  var mask: f32;
  if (g.maskMode < 0.5) {
    mask = hueMask(h, g.hueCenter, g.hueWidth, g.hueSoftness);
  } else if (g.maskMode < 1.5) {
    mask = windowMask(uv, g);
  } else {
    mask = hueMask(h, g.hueCenter, g.hueWidth, g.hueSoftness) * windowMask(uv, g);
  }
  if (g.invert > 0.5) {
    mask = 1.0 - mask;
  }
  return clamp(mask, 0.0, 1.0);
}

fn applyGrade(hsl: vec3<f32>, uv: vec2<f32>, g: SecondaryGradeUniforms) -> vec3<f32> {
  if (g.enabled < 0.5) {
    return hsl;
  }
  let mask = evaluateMask(hsl.x, uv, g);
  if (mask <= 0.0) {
    return hsl;
  }
  var h = fract(hsl.x + g.hueShift * mask);
  if (h < 0.0) { h = h + 1.0; }
  let s = clamp(hsl.y + (hsl.y * (g.satScale - 1.0) + g.satOffset) * mask, 0.0, 1.0);
  let l = clamp(hsl.z + g.lumOffset * mask, 0.0, 1.0);
  return vec3<f32>(h, s, l);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(inputTex, inputSampler, in.uv);
  let mixAmt = clamp(u.amount, 0.0, 1.0);
  if (mixAmt <= 0.0) {
    return src;
  }

  var hsl = rgbToHsl(src.rgb);
  let count = i32(clamp(u.gradeCount, 0.0, 3.0));
  if (count > 0) {
    hsl = applyGrade(hsl, in.uv, u.grades[0]);
  }
  if (count > 1) {
    hsl = applyGrade(hsl, in.uv, u.grades[1]);
  }
  if (count > 2) {
    hsl = applyGrade(hsl, in.uv, u.grades[2]);
  }

  let graded = clamp(hslToRgb(hsl), vec3<f32>(0.0), vec3<f32>(1.0));
  let rgb = mix(src.rgb, graded, mixAmt);
  return vec4<f32>(rgb, src.a);
}
