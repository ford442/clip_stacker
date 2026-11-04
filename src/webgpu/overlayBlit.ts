/**
 * How the preview blits a 2D overlay canvas (titles, captions, shader text
 * fill) onto the composed frame, and the CPU reference of that blit.
 *
 * `overlayPipeline` blends with premultiplied source-over
 * (`src + dst · (1 − src.a)`) and `overlay.wgsl` returns the texel as is, so
 * the texture must hold **premultiplied** colour. `copyExternalImageToTexture`
 * defaults to `premultipliedAlpha: false` (it un-premultiplies the canvas into
 * the texture); with that default every partly covered edge pixel was added
 * at full colour instead of colour × coverage — a bright halo around text
 * that the Canvas2D export (plain source-over) does not have.
 */

/** Destination `premultipliedAlpha` for the overlay upload. Must stay true. */
export const OVERLAY_TEXTURE_PREMULTIPLIED = true;

export type Rgba = readonly [number, number, number, number];

/**
 * What `copyExternalImageToTexture` stores for one canvas pixel, given the
 * pixel's straight-alpha colour (Canvas2D's API colour space).
 */
export function overlayTexel(straight: Rgba, premultipliedAlpha: boolean): Rgba {
  const [r, g, b, a] = straight;
  return premultipliedAlpha ? [r * a, g * a, b * a, a] : [r, g, b, a];
}

/** Bilinear mix of two texels (the sampler is linear), as the GPU filters. */
export function mixTexels(t0: Rgba, t1: Rgba, w: number): Rgba {
  return [0, 1, 2, 3].map((i) => t0[i]! * (1 - w) + t1[i]! * w) as unknown as Rgba;
}

/** The overlay pipeline's blend: premultiplied source-over onto an opaque frame. */
export function blendPremultipliedOver(texel: Rgba, dst: readonly [number, number, number]): Rgba {
  const k = 1 - texel[3];
  return [texel[0] + dst[0] * k, texel[1] + dst[1] * k, texel[2] + dst[2] * k, 1];
}

/** CPU reference of the whole blit for one straight-alpha overlay pixel. */
export function overlayBlitPixel(
  straight: Rgba,
  dst: readonly [number, number, number],
  premultipliedAlpha: boolean = OVERLAY_TEXTURE_PREMULTIPLIED,
): Rgba {
  return blendPremultipliedOver(overlayTexel(straight, premultipliedAlpha), dst);
}

/** Canvas2D `source-over` of a straight-alpha pixel onto an opaque frame (the export). */
export function canvas2dSourceOver(straight: Rgba, dst: readonly [number, number, number]): Rgba {
  const [r, g, b, a] = straight;
  return [r * a + dst[0] * (1 - a), g * a + dst[1] * (1 - a), b * a + dst[2] * (1 - a), 1];
}
