@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var lutTex: texture_3d<f32>;
@group(0) @binding(4) var<uniform> u: LutUniforms;

struct LutUniforms {
  intensity: f32,
  lutSize: f32,
  _pad0: f32,
  _pad1: f32,
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

fn sampleLut(color: vec3<f32>) -> vec3<f32> {
  let scale = (u.lutSize - 1.0) / u.lutSize;
  let offset = 0.5 / u.lutSize;
  let coord = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)) * scale + offset;
  return textureSample(lutTex, lutSampler, coord).rgb;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSample(inputTex, inputSampler, in.uv);
  let graded = sampleLut(src.rgb);
  let mixAmt = clamp(u.intensity, 0.0, 1.0);
  let rgb = mix(src.rgb, graded, mixAmt);
  return vec4<f32>(rgb, src.a);
}
