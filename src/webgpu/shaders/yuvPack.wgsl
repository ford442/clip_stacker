// R'G'B' texture → planar Y'CbCr 4:2:0, limited range, packed into a storage
// buffer as consecutive Y, U, V planes (I420 / I420P10). Mirrors
// packYuvReference() in src/finishing/yuvPack.ts; yuvPack.test.ts pins the
// constants. One invocation writes one u32 word: two 10-bit samples
// (little-endian u16) or four 8-bit ones.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outWords: array<u32>;
@group(0) @binding(2) var<uniform> u: PackUniforms;

struct PackUniforms {
  width: u32,
  height: u32,
  chromaWidth: u32,
  chromaHeight: u32,
  totalSamples: u32,
  wordCount: u32,
  // 0 = I420P10 BT.2020 NCL, 1 = I420 BT.709 (8-bit).
  mode: u32,
  _pad0: u32,
};

const KR_2020: f32 = 0.2627;
const KB_2020: f32 = 0.0593;
const KR_709: f32 = 0.2126;
const KB_709: f32 = 0.0722;

fn kr() -> f32 { return select(KR_709, KR_2020, u.mode == 0u); }
fn kb() -> f32 { return select(KB_709, KB_2020, u.mode == 0u); }

fn rgbAt(x: i32, y: i32) -> vec3<f32> {
  let cx = clamp(x, 0, i32(u.width) - 1);
  let cy = clamp(y, 0, i32(u.height) - 1);
  return clamp(textureLoad(src, vec2<i32>(cx, cy), 0).rgb, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn luma(c: vec3<f32>) -> f32 {
  return kr() * c.r + (1.0 - kr() - kb()) * c.g + kb() * c.b;
}

fn codeScale() -> f32 { return select(1.0, 4.0, u.mode == 0u); }
fn codeMax() -> f32 { return select(255.0, 1023.0, u.mode == 0u); }

fn lumaCode(y: f32) -> u32 {
  return u32(clamp(round((219.0 * clamp(y, 0.0, 1.0) + 16.0) * codeScale()), 0.0, codeMax()));
}

fn chromaCode(c: f32) -> u32 {
  return u32(clamp(round((224.0 * clamp(c, -0.5, 0.5) + 128.0) * codeScale()), 0.0, codeMax()));
}

// [1 2 1] / 4 horizontally around the even luma column, mean of the two rows.
fn chromaSite(cx: i32, cy: i32) -> vec3<f32> {
  let x = cx * 2;
  let y = cy * 2;
  var sum = vec3<f32>(0.0);
  for (var dy = 0; dy < 2; dy++) {
    sum += rgbAt(x - 1, y + dy) * 0.125;
    sum += rgbAt(x, y + dy) * 0.25;
    sum += rgbAt(x + 1, y + dy) * 0.125;
  }
  return sum;
}

fn sampleCode(i: u32) -> u32 {
  let ySamples = u.width * u.height;
  if (i < ySamples) {
    let x = i32(i % u.width);
    let y = i32(i / u.width);
    return lumaCode(luma(rgbAt(x, y)));
  }
  let cSamples = u.chromaWidth * u.chromaHeight;
  var j = i - ySamples;
  var isV = false;
  if (j >= cSamples) {
    j -= cSamples;
    isV = true;
  }
  if (j >= cSamples) {
    return 0u;
  }
  let c = chromaSite(i32(j % u.chromaWidth), i32(j / u.chromaWidth));
  let y = luma(c);
  if (isV) {
    return chromaCode((c.r - y) / (2.0 * (1.0 - kr())));
  }
  return chromaCode((c.b - y) / (2.0 * (1.0 - kb())));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let word = gid.x + gid.y * 65535u * 64u;
  if (word >= u.wordCount) {
    return;
  }
  if (u.mode == 0u) {
    let base = word * 2u;
    let lo = select(0u, sampleCode(base), base < u.totalSamples);
    let hi = select(0u, sampleCode(base + 1u), base + 1u < u.totalSamples);
    outWords[word] = lo | (hi << 16u);
    return;
  }
  let base = word * 4u;
  var packed = 0u;
  for (var k = 0u; k < 4u; k++) {
    if (base + k < u.totalSamples) {
      packed |= (sampleCode(base + k) & 0xffu) << (8u * k);
    }
  }
  outWords[word] = packed;
}
