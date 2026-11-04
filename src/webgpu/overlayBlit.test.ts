import { describe, expect, it } from 'vitest';
import {
  OVERLAY_TEXTURE_PREMULTIPLIED,
  blendPremultipliedOver,
  canvas2dSourceOver,
  mixTexels,
  overlayBlitPixel,
  overlayTexel,
  type Rgba,
} from './overlayBlit';

/** A white glyph's anti-aliased edge: coverage ramps 1 → 0 over a few pixels. */
const EDGE: Rgba[] = [1, 0.85, 0.5, 0.2, 0.05, 0].map((a) => [1, 1, 1, a] as const);
const FRAMES: [number, number, number][] = [
  [0, 0, 0],
  [0.2, 0.4, 0.6],
  [1, 1, 1],
];

function maxAbsDiff(a: Rgba, b: Rgba): number {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
}

describe('overlay blit (text / caption edges)', () => {
  it('uploads premultiplied, as the premultiplied blend expects', () => {
    expect(OVERLAY_TEXTURE_PREMULTIPLIED).toBe(true);
  });

  it('matches the Canvas2D export on every edge pixel (no halo)', () => {
    let worst = 0;
    for (const dst of FRAMES) {
      for (const px of EDGE) worst = Math.max(worst, maxAbsDiff(overlayBlitPixel(px, dst), canvas2dSourceOver(px, dst)));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('also matches between texels, where the linear sampler mixes neighbours', () => {
    let worst = 0;
    for (const dst of FRAMES) {
      for (let i = 0; i + 1 < EDGE.length; i++) {
        for (const w of [0.25, 0.5, 0.75]) {
          const gpu = blendPremultipliedOver(
            mixTexels(overlayTexel(EDGE[i]!, true), overlayTexel(EDGE[i + 1]!, true), w),
            dst,
          );
          // A Canvas2D resample filters premultiplied colour too.
          const a = EDGE[i]![3] * (1 - w) + EDGE[i + 1]![3] * w;
          const ref = canvas2dSourceOver([1, 1, 1, a], dst);
          worst = Math.max(worst, maxAbsDiff(gpu, ref));
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('the old straight-alpha upload is what produced the halo', () => {
    // 50 % coverage white over black: the export gives mid grey, the old
    // blit gave full white.
    const px: Rgba = [1, 1, 1, 0.5];
    expect(canvas2dSourceOver(px, [0, 0, 0])[0]).toBeCloseTo(0.5);
    expect(overlayBlitPixel(px, [0, 0, 0], false)[0]).toBeCloseTo(1);
    expect(overlayBlitPixel(px, [0, 0, 0], true)[0]).toBeCloseTo(0.5);
  });
});
