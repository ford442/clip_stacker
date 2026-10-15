/**
 * The preview.wgsl `Uniforms` block: slot layout, the per-layer draw params
 * and their packing for `PreviewEngine`. `previewUniformLayout.test.ts` pins
 * the offsets against the shader source.
 */

import { AUDIO_UNIFORM_OFFSET, type AudioReactiveState } from "../wasm/audioReactiveUniforms";
import { packWarpUniforms, type Affine2x3 } from "../utils/clipTransform";
import { packKeyUniforms, type LayerKeyUniforms } from "../utils/overlayKey";

/** Must match WGSL Uniforms (36 floats = 144 bytes, 16-byte aligned). */
export const UNIFORM_FLOATS = 36;

/** First slot of the layer warp affine in `Uniforms` (must match preview.wgsl). */
const WARP_UNIFORM_OFFSET = 17;

/** `warpMask` then `quadX/Y/W/H` in `Uniforms` (must match preview.wgsl). */
const WARP_QUAD_UNIFORM_OFFSET = 29;

/** First slot of the chroma/luma key block in `Uniforms` (must match preview.wgsl). */
const KEY_UNIFORM_OFFSET = 23;

export interface NormalizedDestRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayerRenderParams {
  elapsed: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  opacity: number;
  uvScale: [number, number];
  uvOffset: [number, number];
  /**
   * The layer warp (stabilization ∘ inverse picture transform) as one inverse
   * 2x3 affine in the dest rect's normalized UV, `[a, b, tx, c, d, ty]` —
   * see `utils/clipTransform.ts`. Omit (or pass identity) for plain clips.
   */
  warpMatrix?: Affine2x3;
  /** Quad to draw when a picture transform can leave `destRect` (masked outside). */
  warpQuad?: NormalizedDestRect;
  /**
   * Chroma / luma key for this layer. Omit for unkeyed layers — the shader
   * then samples the source as-is.
   */
  key?: LayerKeyUniforms;
  /** Destination rectangle on the canvas in normalized 0–1 coordinates. */
  destRect?: NormalizedDestRect;
  /** When true, clears the canvas before drawing this layer. */
  clear?: boolean;
}

export interface LayerDraw {
  videoFrame: VideoFrame;
  params: LayerRenderParams;
}

/** Write one layer's uniforms (fades, UV, dest rect, audio-reactive, warp, key). */
export function packLayerUniforms(
  uniformData: Float32Array,
  params: LayerRenderParams,
  audioReactive: AudioReactiveState,
): void {
  const dest = params.destRect ?? { x: 0, y: 0, w: 1, h: 1 };
  uniformData[0] = params.fadeIn;
  uniformData[1] = params.fadeOut;
  uniformData[2] = params.duration;
  uniformData[3] = params.elapsed;
  uniformData[4] = params.opacity;
  uniformData[5] = params.uvScale[0];
  uniformData[6] = params.uvScale[1];
  uniformData[7] = params.uvOffset[0];
  uniformData[8] = params.uvOffset[1];
  uniformData[9] = dest.x;
  uniformData[10] = dest.y;
  uniformData[11] = dest.w;
  uniformData[12] = dest.h;
  uniformData[AUDIO_UNIFORM_OFFSET.bass] = audioReactive.bass;
  uniformData[AUDIO_UNIFORM_OFFSET.mid] = audioReactive.mid;
  uniformData[AUDIO_UNIFORM_OFFSET.treble] = audioReactive.treble;
  uniformData[AUDIO_UNIFORM_OFFSET.beat] = audioReactive.beat;
  packWarpUniforms(uniformData, WARP_UNIFORM_OFFSET, params.warpMatrix);
  const quad = params.warpQuad ?? dest;
  uniformData.set([params.warpQuad ? 1 : 0, quad.x, quad.y, quad.w, quad.h], WARP_QUAD_UNIFORM_OFFSET);
  packKeyUniforms(uniformData, KEY_UNIFORM_OFFSET, params.key);
}
