/**
 * The preview.wgsl `Uniforms` block: the per-layer draw params and their
 * packing for `PreviewEngine`. The layout is `PREVIEW_LAYER_UNIFORMS`
 * (`uniformSpecs.ts`); the struct is spliced into the shader from it.
 */

import type { AudioReactiveState } from "../wasm/audioReactiveUniforms";
import { IDENTITY_AFFINE, type Affine2x3 } from "../composition/clipTransform";
import { keyUniformValues, type LayerKeyUniforms } from "../composition/overlayKey";
import type { Vec2 } from "../types/tuples";
import { PREVIEW_LAYER_UNIFORMS } from "./uniformSpecs";

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
  uvScale: Vec2;
  uvOffset: Vec2;
  /**
   * The layer warp (stabilization ∘ inverse picture transform) as one inverse
   * 2x3 affine in the dest rect's normalized UV, `[a, b, tx, c, d, ty]` —
   * see `composition/clipTransform.ts`. Omit (or pass identity) for plain clips.
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
  /**
   * Set by the engine: the source was imported as encoded Display P3, so the
   * key converts the pixel back to the sRGB it was authored against.
   */
  sourceP3?: boolean;
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
  const quad = params.warpQuad ?? dest;
  const [warpA, warpB, warpTx, warpC, warpD, warpTy] = params.warpMatrix ?? IDENTITY_AFFINE;
  PREVIEW_LAYER_UNIFORMS.pack(
    {
      fadeIn: params.fadeIn,
      fadeOut: params.fadeOut,
      duration: params.duration,
      elapsed: params.elapsed,
      opacity: params.opacity,
      uvScaleX: params.uvScale[0],
      uvScaleY: params.uvScale[1],
      uvOffsetX: params.uvOffset[0],
      uvOffsetY: params.uvOffset[1],
      destX: dest.x,
      destY: dest.y,
      destW: dest.w,
      destH: dest.h,
      bass: audioReactive.bass,
      mid: audioReactive.mid,
      treble: audioReactive.treble,
      beat: audioReactive.beat,
      warpA,
      warpB,
      warpTx,
      warpC,
      warpD,
      warpTy,
      ...keyUniformValues(params.key),
      warpMask: params.warpQuad ? 1 : 0,
      quadX: quad.x,
      quadY: quad.y,
      quadW: quad.w,
      quadH: quad.h,
      keySourceP3: params.sourceP3 ? 1 : 0,
    },
    uniformData,
  );
}
