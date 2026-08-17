export const HISTOGRAM_WGSL = /* wgsl */ `
const LUMA = vec3f(0.2126, 0.7152, 0.0722);

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> bins: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(src);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  let color = textureLoad(src, vec2i(gid.xy), 0).rgb;
  let y = saturate(dot(color, LUMA));
  let bin = min(u32(y * 256.0), 255u);
  atomicAdd(&bins[bin], 1u);
}
`;

export const DOWNSAMPLE_WGSL = /* wgsl */ `
struct Size {
  outW: u32,
  outH: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<storage, read_write> outPx: array<u32>;
@group(0) @binding(3) var<uniform> size: Size;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= size.outW || gid.y >= size.outH) {
    return;
  }
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / vec2f(f32(size.outW), f32(size.outH));
  let c = textureSampleLevel(src, samp, uv, 0.0);
  let r = u32(round(clamp(c.r, 0.0, 1.0) * 255.0));
  let g = u32(round(clamp(c.g, 0.0, 1.0) * 255.0));
  let b = u32(round(clamp(c.b, 0.0, 1.0) * 255.0));
  let a = u32(round(clamp(c.a, 0.0, 1.0) * 255.0));
  outPx[gid.y * size.outW + gid.x] = r | (g << 8u) | (b << 16u) | (a << 24u);
}
`;

export const BLUR_H_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  radius: u32,
  _pad: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> tmp: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn pack(c: vec4f) -> u32 {
  let r = u32(round(clamp(c.r, 0.0, 1.0) * 255.0));
  let g = u32(round(clamp(c.g, 0.0, 1.0) * 255.0));
  let b = u32(round(clamp(c.b, 0.0, 1.0) * 255.0));
  let a = u32(round(clamp(c.a, 0.0, 1.0) * 255.0));
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let r = i32(params.radius);
  var acc = vec4f(0.0);
  let ksize = f32(r * 2 + 1);
  for (var k = -r; k <= r; k++) {
    let x = clamp(i32(gid.x) + k, 0, i32(params.width) - 1);
    acc += textureLoad(src, vec2i(x, i32(gid.y)), 0);
  }
  tmp[gid.y * params.width + gid.x] = pack(acc / ksize);
}
`;

export const BLUR_V_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  radius: u32,
  _pad: u32,
};

@group(0) @binding(0) var<storage, read> tmp: array<u32>;
@group(0) @binding(1) var<storage, read_write> outPx: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn unpack(p: u32) -> vec4f {
  let r = f32(p & 255u);
  let g = f32((p >> 8u) & 255u);
  let b = f32((p >> 16u) & 255u);
  let a = f32((p >> 24u) & 255u);
  return vec4f(r, g, b, a);
}

fn pack(c: vec4f) -> u32 {
  let r = u32(round(clamp(c.r / 255.0, 0.0, 1.0) * 255.0));
  let g = u32(round(clamp(c.g / 255.0, 0.0, 1.0) * 255.0));
  let b = u32(round(clamp(c.b / 255.0, 0.0, 1.0) * 255.0));
  let a = u32(round(clamp(c.a / 255.0, 0.0, 1.0) * 255.0));
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let r = i32(params.radius);
  var acc = vec4f(0.0);
  let ksize = f32(r * 2 + 1);
  for (var k = -r; k <= r; k++) {
    let y = u32(clamp(i32(gid.y) + k, 0, i32(params.height) - 1));
    acc += unpack(tmp[y * params.width + gid.x]);
  }
  outPx[gid.y * params.width + gid.x] = pack(acc / ksize);
}
`;
