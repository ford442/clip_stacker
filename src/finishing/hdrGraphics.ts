/**
 * Titles and captions in an HDR10 export (CPU reference).
 *
 * The 2D text pass draws sRGB onto a transparent canvas; the managed chain
 * composites that canvas in the scene-linear Rec.2020 working space before
 * the output transform, with sRGB white at the graphics white (ITU-R BT.2408,
 * {@link DEFAULT_GRAPHICS_WHITE_NITS}). `graphicsOverlay.wgsl` mirrors
 * {@link graphicsOverlayPixel}; `hdrGraphics.test.ts` pins both.
 *
 * Compositing is in linear light (premultiplied source-over), so an
 * anti-aliased edge blends by coverage of light, not of code values.
 */

import {
  REC709_TO_REC2020,
  mulMat3Vec,
  type Mat3,
} from './colorManagement';

export type Rgb = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];

export function srgbToLinearChannel(c: number): number {
  const v = Math.max(c, 0);
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * One premultiplied, sRGB-encoded overlay texel → premultiplied scene-linear
 * Rec.2020 (what the pass outputs before blending).
 */
export function graphicsOverlayTexel(
  premultiplied: Rgba,
  gain: number,
  matrix: Mat3 = REC709_TO_REC2020,
): Rgba {
  const a = premultiplied[3];
  if (a <= 0) return [0, 0, 0, 0];
  const straight: [number, number, number] = [
    srgbToLinearChannel(premultiplied[0] / a),
    srgbToLinearChannel(premultiplied[1] / a),
    srgbToLinearChannel(premultiplied[2] / a),
  ];
  const lin = mulMat3Vec(matrix, straight);
  return [lin[0] * gain * a, lin[1] * gain * a, lin[2] * gain * a, a];
}

/** The whole composite for one pixel: overlay texel over a working-space pixel. */
export function graphicsOverlayPixel(
  premultiplied: Rgba,
  background: Rgb,
  gain: number,
): Rgb {
  const t = graphicsOverlayTexel(premultiplied, gain);
  const k = 1 - t[3];
  return [t[0] + background[0] * k, t[1] + background[1] * k, t[2] + background[2] * k];
}
