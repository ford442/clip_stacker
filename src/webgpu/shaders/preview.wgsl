@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct Uniforms {
  fadeIn: f32,
  fadeOut: f32,
  duration: f32,
  elapsed: f32,
  opacity: f32,
  uvScaleX: f32,
  uvScaleY: f32,
  uvOffsetX: f32,
  uvOffsetY: f32,
  destX: f32,
  destY: f32,
  destW: f32,
  destH: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

struct VertexOutput {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Full-screen quad using 6 vertices (2 triangles)
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
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0),
  );

  let unit = unitPositions[idx];
  let ndcLeft = u.destX * 2.0 - 1.0;
  let ndcRight = (u.destX + u.destW) * 2.0 - 1.0;
  let ndcTop = 1.0 - u.destY * 2.0;
  let ndcBottom = 1.0 - (u.destY + u.destH) * 2.0;
  let ndcX = mix(ndcLeft, ndcRight, unit.x);
  let ndcY = mix(ndcBottom, ndcTop, unit.y);

  var out: VertexOutput;
  out.pos = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  let baseUv = uvs[idx];
  out.uv = baseUv * vec2<f32>(u.uvScaleX, u.uvScaleY) + vec2<f32>(u.uvOffsetX, u.uvOffsetY);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  var color = textureSampleBaseClampToEdge(videoTexture, videoSampler, in.uv);

  var fadeAlpha = 1.0;
  if (u.fadeIn > 0.0 && u.elapsed < u.fadeIn) {
    fadeAlpha = u.elapsed / u.fadeIn;
  }
  if (u.fadeOut > 0.0 && u.duration > 0.0 && u.elapsed > (u.duration - u.fadeOut)) {
    let fadeOutAlpha = (u.duration - u.elapsed) / u.fadeOut;
    fadeAlpha = min(fadeAlpha, fadeOutAlpha);
  }
  fadeAlpha = clamp(fadeAlpha, 0.0, 1.0) * clamp(u.opacity, 0.0, 1.0);

  return vec4<f32>(color.rgb * fadeAlpha, color.a * fadeAlpha);
}
