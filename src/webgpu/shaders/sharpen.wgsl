@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: SharpenUniforms;

struct SharpenUniforms {
  // vec4 0
  amount: f32,
  radius: f32,
  threshold: f32,
  midtoneDetail: f32,
  // vec4 1
  texelSize: vec2<f32>,
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

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn rgbToYuv(c: vec3<f32>) -> vec3<f32> {
  let y = luma(c);
  let uCh = (c.b - y) * 0.565;
  let vCh = (c.r - y) * 0.713;
  return vec3<f32>(y, uCh, vCh);
}

fn yuvToRgb(yuv: vec3<f32>) -> vec3<f32> {
  let r = yuv.x + 1.403 * yuv.z;
  let g = yuv.x - 0.344 * yuv.y - 0.714 * yuv.z;
  let b = yuv.x + 1.770 * yuv.y;
  return vec3<f32>(r, g, b);
}

/// Single-pass Gaussian blur of luma (approximates separable H/V for radius ≤ 3).
fn blurLuma(uv: vec2<f32>) -> f32 {
  let radius = clamp(u.radius, 0.5, 3.0);
  let sigma = max(radius * 0.5, 0.2);
  let twoSigma2 = 2.0 * sigma * sigma;
  let limit = i32(ceil(radius));

  var sum = 0.0;
  var wSum = 0.0;
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      if (abs(dx) > limit || abs(dy) > limit) {
        continue;
      }
      let d2 = f32(dx * dx + dy * dy);
      let w = exp(-d2 / twoSigma2);
      let sampleUv = uv + vec2<f32>(f32(dx), f32(dy)) * u.texelSize;
      let sample = textureSampleLevel(inputTex, inputSampler, sampleUv, 0.0);
      sum += luma(sample.rgb) * w;
      wSum += w;
    }
  }
  if (wSum <= 1e-6) {
    let center = textureSampleLevel(inputTex, inputSampler, uv, 0.0);
    return luma(center.rgb);
  }
  return sum / wSum;
}

/// Soft midtone weight peaking near 0.5, fade outside ~0.2–0.8.
fn midtoneWeight(y: f32) -> f32 {
  return smoothstep(0.15, 0.3, y) * (1.0 - smoothstep(0.7, 0.85, y));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(inputTex, inputSampler, in.uv, 0.0);
  let amount = clamp(u.amount, 0.0, 1.0);
  let midtone = clamp(u.midtoneDetail, 0.0, 1.0);
  if (amount <= 0.0 && midtone <= 0.0) {
    return src;
  }

  let yuv = rgbToYuv(src.rgb);
  let y = yuv.x;
  let blurred = blurLuma(in.uv);
  let detail = y - blurred;

  // Threshold: skip sharpening on near-flat regions (reduces noise amplification).
  let thr = clamp(u.threshold, 0.0, 1.0);
  let gate = select(0.0, 1.0, abs(detail) > thr);

  // Unsharp: restore high-frequency edges on luma only.
  var outY = y + amount * detail * gate;

  // Midtone detail: local contrast (reuse high-pass) weighted to midtones only.
  outY = outY + midtone * midtoneWeight(y) * detail;

  outY = clamp(outY, 0.0, 1.0);
  let rgb = clamp(yuvToRgb(vec3<f32>(outY, yuv.y, yuv.z)), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb, src.a);
}
