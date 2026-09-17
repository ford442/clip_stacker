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
  // Audio-reactive (from WASM FFT analysis); zeros when disabled
  bass: f32,
  mid: f32,
  treble: f32,
  beat: f32,
  // Stabilization: inverse-warp 2x3 affine in normalized UV, centred on the
  // frame. Identity (1,0,0, 0,1,0) when the clip is not stabilized.
  stabA: f32,
  stabB: f32,
  stabTx: f32,
  stabC: f32,
  stabD: f32,
  stabTy: f32,
  // Chroma / luma key (see src/utils/overlayKey.ts — keyPixel() is the same
  // function in TypeScript and is what the unit tests pin down).
  // keyMode: 0 = none, 1 = chroma, 2 = luma.
  keyMode: f32,
  keyR: f32,
  keyG: f32,
  keyB: f32,
  keySimilarity: f32,
  keyBlend: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

// BT.601 luma — the `Y` plane FFmpeg's lumakey reads.
fn lumaBt601(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

// BT.601 U/V for *limited* range (224 of 255 code values), with the +128
// offset dropped because only differences are used. Matching the range matters:
// full-range UV would come out ~14% further apart and key more than FFmpeg.
fn chromaUv(c: vec3<f32>) -> vec2<f32> {
  let y = lumaBt601(c);
  let scale = 224.0 / 255.0;
  return vec2<f32>(scale * (c.b - y) / 1.772, scale * (c.r - y) / 1.402);
}

/**
 * Alpha multiplier for one pixel: 0 = keyed out, 1 = kept.
 *
 * Chroma follows `vf_chromakey.c` (normalized Euclidean UV distance ramped
 * from similarity over blend, hard cut when blend is ~0); luma follows
 * `vf_lumakey.c` as `buildOverlayAlphaFilters` configures it (threshold=0,
 * tolerance=similarity, softness=blend).
 */
fn keyAlpha(color: vec3<f32>) -> f32 {
  if (u.keyMode < 0.5) {
    return 1.0;
  }

  if (u.keyMode < 1.5) {
    let d = chromaUv(color) - chromaUv(vec3<f32>(u.keyR, u.keyG, u.keyB));
    let diff = sqrt(dot(d, d) / 2.0);
    if (u.keyBlend > 0.0001) {
      return clamp((diff - u.keySimilarity) / u.keyBlend, 0.0, 1.0);
    }
    return select(0.0, 1.0, diff > u.keySimilarity);
  }

  let white = clamp(u.keySimilarity, 0.0, 1.0);
  let luma = lumaBt601(color);
  if (luma <= white) {
    return 0.0;
  }
  if (u.keyBlend > 0.0001) {
    return clamp((luma - white) / u.keyBlend, 0.0, 1.0);
  }
  return 1.0;
}

/**
 * Camera-shake correction. Applied to the source UV before the letterbox map,
 * about the frame centre, so it composes with Ken Burns instead of fighting it.
 *
 * This is an inverse warp done in the vertex shader rather than a separate
 * compute pass: the correction is affine, so evaluating it at the three
 * corners and letting the rasteriser interpolate is exact, and it costs no
 * intermediate texture.
 */
fn applyStabilization(uv: vec2<f32>) -> vec2<f32> {
  let centered = uv - vec2<f32>(0.5, 0.5);
  return vec2<f32>(
    u.stabA * centered.x + u.stabB * centered.y + u.stabTx,
    u.stabC * centered.x + u.stabD * centered.y + u.stabTy,
  ) + vec2<f32>(0.5, 0.5);
}

fn applyAudioReactive(color: vec3<f32>, bass: f32, beat: f32) -> vec3<f32> {
  let pulse = clamp(bass * 0.15 + beat * 0.1, 0.0, 0.25);
  let warm = vec3<f32>(1.0, 0.85, 0.65);
  return mix(color, color * warm, pulse);
}

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
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
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
  let baseUv = applyStabilization(uvs[idx]);
  out.uv = baseUv * vec2<f32>(u.uvScaleX, u.uvScaleY) + vec2<f32>(u.uvOffsetX, u.uvOffsetY);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  var color = textureSampleBaseClampToEdge(videoTexture, videoSampler, in.uv);

  // Keying runs on the sampled colour, before opacity and the fades multiply
  // in, so the key's soft edge is not squashed by them.
  let keyed = keyAlpha(color.rgb);

  var fadeAlpha = 1.0;
  if (u.fadeIn > 0.0 && u.elapsed < u.fadeIn) {
    fadeAlpha = u.elapsed / u.fadeIn;
  }
  if (u.fadeOut > 0.0 && u.duration > 0.0 && u.elapsed > (u.duration - u.fadeOut)) {
    let fadeOutAlpha = (u.duration - u.elapsed) / u.fadeOut;
    fadeAlpha = min(fadeAlpha, fadeOutAlpha);
  }
  fadeAlpha = clamp(fadeAlpha, 0.0, 1.0) * clamp(u.opacity, 0.0, 1.0);

  let rgb = applyAudioReactive(color.rgb, u.bass, u.beat);
  let outAlpha = fadeAlpha * keyed;
  return vec4<f32>(rgb * outAlpha, color.a * outAlpha);
}
