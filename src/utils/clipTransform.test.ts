import { describe, expect, it } from 'vitest';
import {
  applyAffine,
  buildFfmpegFramePictureFilters,
  buildFfmpegPictureFilters,
  buildPictureTransform,
  composeAffine,
  composeLayerWarp,
  IDENTITY_AFFINE,
  IDENTITY_PICTURE_TRANSFORM,
  invertAffine,
  isIdentityAffine,
  layerWarpDrawParams,
  layerWarpFields,
  packWarpUniforms,
  pictureBounds,
  transitionWarpParams,
  type Affine2x3,
  type PictureTransform,
} from './clipTransform';
import { invertPixelAffine, stabMatrixToCanvasTransform } from './stabilization';

const deg = (d: number) => (d * Math.PI) / 180;

function picture(overrides: Partial<PictureTransform>): PictureTransform {
  return { ...IDENTITY_PICTURE_TRANSFORM, ...overrides };
}

/** Sample an inverse warp the way preview.wgsl's applyLayerWarp() does. */
function warpUv(m: Affine2x3, u: number, v: number): [number, number] {
  const [x, y] = applyAffine(m, u - 0.5, v - 0.5);
  return [x + 0.5, y + 0.5];
}

function expectAffineClose(actual: Affine2x3, expected: Affine2x3, digits = 9): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, digits));
}

describe('composeAffine / invertAffine', () => {
  const a: Affine2x3 = [0.9, 0.1, 0.05, -0.2, 1.1, -0.03];
  const b: Affine2x3 = [1.2, -0.4, 0.2, 0.3, 0.8, 0.1];

  it('composes right-to-left: inner first, then outer', () => {
    const p: [number, number] = [0.3, -0.2];
    const viaCompose = applyAffine(composeAffine(a, b), ...p);
    const viaSteps = applyAffine(a, ...applyAffine(b, ...p));
    expect(viaCompose[0]).toBeCloseTo(viaSteps[0], 12);
    expect(viaCompose[1]).toBeCloseTo(viaSteps[1], 12);
  });

  it('is not commutative (order is load-bearing)', () => {
    expect(composeAffine(a, b)).not.toEqual(composeAffine(b, a));
  });

  it('inverts so that m ∘ m⁻¹ = m⁻¹ ∘ m = identity', () => {
    expectAffineClose(composeAffine(a, invertAffine(a)), IDENTITY_AFFINE);
    expectAffineClose(composeAffine(invertAffine(a), a), IDENTITY_AFFINE);
  });

  it('agrees with the stabilization pixel inverse', () => {
    expect(invertAffine(a)).toEqual(invertPixelAffine(a));
  });

  it('returns identity for a singular matrix rather than NaN', () => {
    expect(invertAffine([0, 0, 1, 0, 0, 1])).toEqual(IDENTITY_AFFINE);
  });

  it('keeps identity exactly identity', () => {
    expect(composeAffine(IDENTITY_AFFINE, IDENTITY_AFFINE)).toEqual([1, 0, 0, 0, 1, 0]);
    expect(invertAffine(IDENTITY_AFFINE)).toEqual([1, 0, 0, 0, 1, 0]);
  });
});

describe('buildPictureTransform', () => {
  const box = { width: 160, height: 90 };

  it('is exactly identity at rotation 0 / scale 1', () => {
    expect(buildPictureTransform(IDENTITY_PICTURE_TRANSFORM, box)).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('rotates rigidly (clockwise, y-down) on a non-square rect', () => {
    const warp = composeLayerWarp(undefined, buildPictureTransform(picture({ rotation: deg(90) }), box));
    // 20 px below the centre on screen came from 20 px right of centre in the
    // picture: clockwise turns +x into +y.
    const [u, v] = warpUv(warp, 0.5, 0.5 + 20 / 90);
    expect(u).toBeCloseTo(0.5 + 20 / 160, 9);
    expect(v).toBeCloseTo(0.5, 9);
  });

  it('keeps the anchor fixed', () => {
    const forward = buildPictureTransform(
      picture({ rotation: deg(37), scaleX: 1.7, scaleY: 0.6, anchorX: 0, anchorY: 0 }),
      box,
    );
    const [x, y] = applyAffine(forward, -0.5, -0.5);
    expect(x).toBeCloseTo(-0.5, 12);
    expect(y).toBeCloseTo(-0.5, 12);
  });

  it('scales about the centre by default', () => {
    const forward = buildPictureTransform(picture({ scaleX: 2, scaleY: 0.5 }), box);
    expect(applyAffine(forward, 0.5, 0.5)).toEqual([1, 0.25]);
  });

  it('translates in frame units', () => {
    const forward = buildPictureTransform(
      picture({ x: 0.1 }),
      { width: 100, height: 100 },
      { width: 1000, height: 1000 },
    );
    expect(applyAffine(forward, 0, 0)[0]).toBeCloseTo(1, 12);
  });

  it('never builds a singular matrix from a zero scale', () => {
    const forward = buildPictureTransform(picture({ scaleX: 0 }), box);
    expect(invertAffine(forward)).not.toEqual(IDENTITY_AFFINE);
  });
});

describe('composeLayerWarp', () => {
  const stab: Affine2x3 = [0.98, 0.01, 0.02, -0.01, 0.98, -0.015];
  const forward = buildPictureTransform(
    picture({ rotation: deg(30), scaleX: 0.8, scaleY: 0.8, anchorX: 0.3 }),
    { width: 192, height: 108 },
  );

  it('stabilizes first, then applies the authored transform (stab ∘ picture⁻¹)', () => {
    const warp = composeLayerWarp(stab, forward);
    const p: [number, number] = [0.12, -0.31];
    const expected = applyAffine(stab, ...applyAffine(invertAffine(forward), ...p));
    const actual = applyAffine(warp, ...p);
    expect(actual[0]).toBeCloseTo(expected[0], 12);
    expect(actual[1]).toBeCloseTo(expected[1], 12);
  });

  it('is the stabilization matrix unchanged when there is no picture transform', () => {
    expect(composeLayerWarp(stab, undefined)).toEqual(stab);
  });

  it('is identity when there is nothing to apply', () => {
    expect(composeLayerWarp(undefined, undefined)).toEqual([1, 0, 0, 0, 1, 0]);
  });
});

describe('layerWarpFields', () => {
  const box = { width: 1920, height: 1080 };

  it('rotation 0 and scale 1 reproduce today\'s dest rect + UV (no fields at all)', () => {
    expect(layerWarpFields(undefined, IDENTITY_PICTURE_TRANSFORM, box, box)).toEqual({});
    // An anchor alone moves nothing.
    expect(
      layerWarpFields(undefined, picture({ anchorX: 0, anchorY: 1 }), box, box),
    ).toEqual({});
    // And the draw params stay the plain dest-rect quad.
    expect(layerWarpDrawParams({}, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({});
  });

  it('passes a stabilization matrix through bit-for-bit and keeps the rect quad', () => {
    const stab: Affine2x3 = [1.01, 0.002, 0.003, -0.002, 1.01, 0.004];
    const fields = layerWarpFields(stab, IDENTITY_PICTURE_TRANSFORM, box, box);
    expect(fields).toEqual({ warpMatrix: stab });
    expect(layerWarpDrawParams(fields, { x: 0, y: 0, w: 1, h: 1 })).toEqual({
      warpMatrix: stab,
    });
  });

  it('carries the forward matrix (and so a grown quad) only for a real transform', () => {
    const fields = layerWarpFields(undefined, picture({ rotation: deg(90) }), box, box);
    expect(fields.pictureMatrix).toBeDefined();
    expect(fields.warpMatrix).toBeDefined();
    const draw = layerWarpDrawParams(fields, { x: 0, y: 0, w: 1, h: 1 });
    // 16:9 turned 90°: a 9:16 box about the same centre, in canvas units.
    expect(draw.warpQuad!.x).toBeCloseTo(0.5 - (0.5 * 1080) / 1920, 9);
    expect(draw.warpQuad!.w).toBeCloseTo(1080 / 1920, 9);
    expect(draw.warpQuad!.y).toBeCloseTo(0.5 - (0.5 * 1920) / 1080, 9);
    expect(draw.warpQuad!.h).toBeCloseTo(1920 / 1080, 9);
  });

  it('feeds both sides of a transition through the same composed warp', () => {
    const stab: Affine2x3 = [1, 0, 0.01, 0, 1, 0.02];
    const from = layerWarpFields(stab, picture({ rotation: deg(15) }), box, box);
    const to = layerWarpFields(stab, IDENTITY_PICTURE_TRANSFORM, box, box);
    expect(transitionWarpParams(from, to)).toEqual({
      fromWarpMatrix: from.warpMatrix,
      toWarpMatrix: stab,
      fromWarpMasked: true,
      toWarpMasked: false,
    });
  });

  it('packs identity when the matrix is omitted', () => {
    const buffer = new Float32Array(8).fill(9);
    packWarpUniforms(buffer, 1, undefined);
    expect(Array.from(buffer)).toEqual([9, 1, 0, 0, 0, 1, 0, 9]);
  });
});

describe('pictureBounds', () => {
  it('is the rect itself for identity', () => {
    const rect = { x: 10, y: 20, width: 300, height: 200 };
    expect(pictureBounds(IDENTITY_AFFINE, rect)).toEqual(rect);
  });

  it('swaps width and height about the centre at 90°', () => {
    const rect = { x: 0, y: 0, width: 160, height: 90 };
    const b = pictureBounds(buildPictureTransform(picture({ rotation: deg(90) }), rect), rect);
    expect(b.x).toBeCloseTo(35, 9);
    expect(b.y).toBeCloseTo(-35, 9);
    expect(b.width).toBeCloseTo(90, 9);
    expect(b.height).toBeCloseTo(160, 9);
  });
});

/**
 * GPU vs Canvas2D framing parity for a rotate + scale (+ stabilization) case.
 *
 * Neither path can run here (no WebGPU, and happy-dom has no rasteriser), so
 * this reproduces what each one does with the same matrix:
 *
 * - GPU (preview.wgsl): for each output pixel centre in the warp quad, take
 *   its rect UV, apply the inverse warp, mask outside [0, 1], sample.
 * - Canvas2D (canvas-renderer-layers.ts): `ctx.transform` with
 *   `stabMatrixToCanvasTransform(warp, rect)`, then `drawImage` of the picture
 *   into the rect. A Canvas2D rasteriser samples each output pixel through
 *   the inverse of that context transform.
 *
 * Pixel tolerance: interior pixels must match exactly (both use nearest
 * sampling of the same source pixel, so any drift would be a matrix bug).
 * Pixels whose centre lies within half a pixel of the picture edge may
 * differ in coverage — the GPU antialiases with a one-pixel fwidth ramp and
 * Canvas2D with its own edge coverage — so at most 2% of the frame may
 * disagree, and only on the edge.
 */
describe('GPU / Canvas2D framing parity', () => {
  const W = 96;
  const H = 54;
  const rect = { x: 0, y: 0, width: W, height: H };
  // Distinct value per source pixel, so any mis-mapping shows up.
  const source = (px: number, py: number) => py * W + px;

  const stab: Affine2x3 = [0.99, 0.004, 0.006, -0.004, 0.99, -0.008];
  const t = picture({ rotation: deg(33), scaleX: 0.7, scaleY: 0.85, anchorX: 0.4, anchorY: 0.55 });
  const forward = buildPictureTransform(t, rect);
  const warp = composeLayerWarp(stab, forward);

  function rasterGpu(): Array<number | null> {
    const out: Array<number | null> = new Array(W * H).fill(null);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [u, v] = warpUv(warp, (x + 0.5) / W, (y + 0.5) / H);
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        out[y * W + x] = source(Math.min(W - 1, Math.floor(u * W)), Math.min(H - 1, Math.floor(v * H)));
      }
    }
    return out;
  }

  function rasterCanvas(): Array<number | null> {
    const ctxTransform = stabMatrixToCanvasTransform(warp, rect.width, rect.height);
    const toPicture = invertPixelAffine(ctxTransform);
    const out: Array<number | null> = new Array(W * H).fill(null);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [px, py] = applyAffine(toPicture, x + 0.5, y + 0.5);
        if (px < 0 || px > W || py < 0 || py > H) continue;
        out[y * W + x] = source(Math.min(W - 1, Math.floor(px)), Math.min(H - 1, Math.floor(py)));
      }
    }
    return out;
  }

  it('frames a rotated + scaled + stabilized clip identically', () => {
    const gpu = rasterGpu();
    const canvas = rasterCanvas();
    let coverageMismatch = 0;
    let valueMismatch = 0;
    for (let i = 0; i < gpu.length; i++) {
      if ((gpu[i] === null) !== (canvas[i] === null)) coverageMismatch++;
      else if (gpu[i] !== canvas[i]) valueMismatch++;
    }
    expect(valueMismatch).toBe(0);
    expect(coverageMismatch / gpu.length).toBeLessThanOrEqual(0.02);
    // Sanity: the picture is actually rotated off some of the frame.
    expect(gpu.filter((v) => v === null).length).toBeGreaterThan(W * H * 0.1);
  });
});

describe('FFmpeg picture filters', () => {
  const frame = { width: 1920, height: 1080 };

  it('rotates a PiP into its bounding box, positioned where the GPU puts it', () => {
    const placed = buildFfmpegPictureFilters(
      picture({ rotation: deg(90) }),
      { x: 100, y: 100, width: 320, height: 180 },
      frame,
    );
    expect(placed.filters).toEqual(['scale=320:180', 'rotate=1.570796:ow=180:oh=320:c=none']);
    expect(placed).toMatchObject({ x: 170, y: 30, width: 180, height: 320 });
  });

  it('honours the anchor through the overlay position', () => {
    const placed = buildFfmpegPictureFilters(
      picture({ scaleX: 0.5, scaleY: 0.5, anchorX: 0, anchorY: 0 }),
      { x: 100, y: 100, width: 320, height: 180 },
      frame,
    );
    expect(placed.filters).toEqual(['scale=160:90']);
    expect(placed).toMatchObject({ x: 100, y: 100, width: 160, height: 90 });
  });

  it('places a rotated base frame back on a black full-size canvas', () => {
    expect(buildFfmpegFramePictureFilters(picture({ rotation: deg(90) }), frame)).toEqual([
      'scale=1920:1080',
      'rotate=1.570796:ow=1080:oh=1920:c=black',
      'crop=1080:1080:0:420',
      'pad=1920:1080:420:0:black',
    ]);
  });

  it('blanks a base frame moved entirely off-canvas instead of emitting a bad crop', () => {
    expect(
      buildFfmpegFramePictureFilters(picture({ x: 2, scaleX: 0.5, scaleY: 0.5 }), frame),
    ).toEqual(['drawbox=c=black:t=fill']);
  });

  it('keeps identity detectable for callers that skip the chain', () => {
    expect(isIdentityAffine(buildPictureTransform(IDENTITY_PICTURE_TRANSFORM, frame))).toBe(true);
  });
});
