// Preview frame cache (`previewFrameCache.ts`): present a cached composed
// frame on the canvas. One full-screen triangle; each pixel loads its own
// texel (no filtering), so a hit shows exactly the frame that was stored.

@group(0) @binding(0) var cached: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -3.0), vec2<f32>(-1.0, 1.0), vec2<f32>(3.0, 1.0));
  return vec4<f32>(corners[index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(cached, vec2<i32>(position.xy), 0);
}
