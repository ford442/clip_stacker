// Titles / captions for an HDR10 export: the 2D text canvas (premultiplied,
// sRGB-encoded) composited onto the scene-linear Rec.2020 working texture
// before the output transform. Mirrors graphicsOverlayTexel() in
// src/finishing/hdrGraphics.ts. The pipeline blends one / one-minus-src-alpha
// onto the working texture in place (loadOp load).

@group(0) @binding(0) var overlayTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: GraphicsUniforms;

struct GraphicsUniforms {
  // sRGB white → this scene-linear value (graphics white / reference white).
  gain: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  // Rec.709 → Rec.2020 rows.
  row0: vec4<f32>,
  row1: vec4<f32>,
  row2: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  return vec4<f32>(positions[idx], 0.0, 1.0);
}

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let v = max(c, vec3<f32>(0.0));
  let lo = v / 12.92;
  let hi = pow((v + 0.055) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, v <= vec3<f32>(0.04045));
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let texel = textureLoad(overlayTex, vec2<i32>(pos.xy), 0);
  let a = texel.a;
  if (a <= 0.0) {
    return vec4<f32>(0.0);
  }
  let lin709 = srgbToLinear(texel.rgb / a);
  let lin = vec3<f32>(dot(u.row0.xyz, lin709), dot(u.row1.xyz, lin709), dot(u.row2.xyz, lin709));
  return vec4<f32>(lin * u.gain * a, a);
}
