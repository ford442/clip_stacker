/**
 * One warp per layer sample.
 *
 * A clip's picture reaches every compositor — the WebGPU preview, GPU export
 * (which reuses the preview renderer), the transition shader's `sampleFrom` /
 * `sampleTo`, and the Canvas2D path — as a single inverse 2x3 affine in
 * normalized UV, `[a, b, tx, c, d, ty]`:
 *
 *   srcUv = M · (outUv − 0.5) + t + 0.5
 *
 * where `outUv` is a position inside the layer's destination rect (0–1 across
 * the rect) and `srcUv` is where to sample the picture. Identity is
 * `[1, 0, 0, 0, 1, 0]`, and every unstabilized, untransformed path passes
 * exactly that (or omits the matrix, which means the same thing).
 *
 * The matrix is the composition of two things, which used to be separate:
 *
 * 1. the stabilization matrix (`stabilization.ts`), already an inverse warp in
 *    this convention, and
 * 2. the authored picture transform — position, scale, rotation and anchor —
 *    built here as a *forward* map and inverted.
 *
 * Multiply order: the picture is stabilized first, then the authored
 * transform moves it. As an inverse lookup that reads right-to-left from the
 * output pixel: undo the authored transform, then apply the stabilization
 * correction — `warp = stab ∘ picture⁻¹` (see {@link composeLayerWarp}).
 *
 * Everything here is pure arithmetic so it stays testable without a GPU.
 * Ken Burns UV scale/offset and the letterbox map still apply *after* the
 * warp, on the sampled UV, exactly as they did before this module existed.
 */

import { IDENTITY_STAB_MATRIX, type StabMatrix } from '../wasm/videoStabilize';

/** `[a, b, tx, c, d, ty]` — same layout as a stabilization matrix. */
export type Affine2x3 = StabMatrix;

export const IDENTITY_AFFINE: Affine2x3 = IDENTITY_STAB_MATRIX;

/** Smallest |scale| a picture transform is built with, so it stays invertible. */
export const MIN_PICTURE_SCALE = 1e-3;

/** Authored picture transform, as sampled at one instant. */
export interface PictureTransform {
  /** Extra translation in output-normalized units (0–1 of the frame width). */
  x: number;
  /** Extra translation in output-normalized units (0–1 of the frame height). */
  y: number;
  scaleX: number;
  scaleY: number;
  /** Clockwise, in radians (y-down, like CSS / Canvas2D / FFmpeg `rotate`). */
  rotation: number;
  /** Pivot inside the layer rect, 0–1 (0.5, 0.5 = centre). */
  anchorX: number;
  anchorY: number;
}

export const IDENTITY_PICTURE_TRANSFORM: PictureTransform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
};

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/** `-0 + 0` is `+0`: keeps identity printing (and comparing) as `[1,0,0,0,1,0]`. */
function clean(m: readonly number[]): Affine2x3 {
  return [m[0]! + 0, m[1]! + 0, m[2]! + 0, m[3]! + 0, m[4]! + 0, m[5]! + 0];
}

export function isIdentityAffine(m: Affine2x3, epsilon = 0): boolean {
  return (
    Math.abs(m[0] - 1) <= epsilon &&
    Math.abs(m[1]) <= epsilon &&
    Math.abs(m[2]) <= epsilon &&
    Math.abs(m[3]) <= epsilon &&
    Math.abs(m[4] - 1) <= epsilon &&
    Math.abs(m[5]) <= epsilon
  );
}

/** Apply `m` to a point (in whatever centred space the matrix is defined). */
export function applyAffine(m: Affine2x3, x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/**
 * `outer ∘ inner`: the affine that applies `inner` first, then `outer`.
 * `applyAffine(composeAffine(a, b), p)` equals `applyAffine(a, applyAffine(b, p))`.
 */
export function composeAffine(outer: Affine2x3, inner: Affine2x3): Affine2x3 {
  const [a1, b1, tx1, c1, d1, ty1] = outer;
  const [a2, b2, tx2, c2, d2, ty2] = inner;
  return clean([
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    a1 * tx2 + b1 * ty2 + tx1,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    c1 * tx2 + d1 * ty2 + ty1,
  ]);
}

/** Inverse of `m`, or identity when `m` is singular (or not finite). */
export function invertAffine(m: Affine2x3): Affine2x3 {
  const [a, b, tx, c, d, ty] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return IDENTITY_AFFINE;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return clean([ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)]);
}

export function isIdentityPictureTransform(t: PictureTransform): boolean {
  return (
    t.x === 0 &&
    t.y === 0 &&
    t.scaleX === 1 &&
    t.scaleY === 1 &&
    t.rotation === 0
  );
}

function safeScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (Math.abs(value) >= MIN_PICTURE_SCALE) return value;
  return value < 0 ? -MIN_PICTURE_SCALE : MIN_PICTURE_SCALE;
}

/**
 * Forward picture transform in the layer rect's centred UV.
 *
 * Built in pixels and normalized back, so a rotation stays rigid on a
 * non-square rect (rotating directly in UV would shear it). `box` is the layer
 * rect and `frame` the canvas it lives on (only needed for `x` / `y`, which
 * are authored in frame units like the rest of the layout).
 *
 * In pixels about the rect centre: `P' = R·S·(P − anchor) + anchor + T`.
 */
export function buildPictureTransform(
  t: PictureTransform,
  box: Size,
  frame: Size = box,
): Affine2x3 {
  const w = Math.max(box.width, 1e-9);
  const h = Math.max(box.height, 1e-9);
  const sx = safeScale(t.scaleX);
  const sy = safeScale(t.scaleY);
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  // L = D⁻¹ · R · S · D with D = diag(w, h).
  const a = cos * sx;
  const b = (-sin * sy * h) / w;
  const c = (sin * sx * w) / h;
  const d = cos * sy;
  const ax = (Number.isFinite(t.anchorX) ? t.anchorX : 0.5) - 0.5;
  const ay = (Number.isFinite(t.anchorY) ? t.anchorY : 0.5) - 0.5;
  const tx = ax - (a * ax + b * ay) + (t.x * frame.width) / w;
  const ty = ay - (c * ax + d * ay) + (t.y * frame.height) / h;
  return clean([a, b, tx, c, d, ty]);
}

/**
 * The one inverse warp a layer is sampled through: stabilize first, then the
 * authored transform (`stab ∘ picture⁻¹`). Either input may be omitted.
 */
export function composeLayerWarp(
  stab: StabMatrix | undefined,
  picture: Affine2x3 | undefined,
): Affine2x3 {
  const pictureInverse = picture ? invertAffine(picture) : IDENTITY_AFFINE;
  return composeAffine(stab ?? IDENTITY_AFFINE, pictureInverse);
}

/**
 * Axis-aligned bounds, in the same units as `box`, of the rect after the
 * forward picture transform — the quad the GPU has to cover so a rotated or
 * scaled picture is not clipped to its original rect.
 */
export function pictureBounds(picture: Affine2x3, box: Rect): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [-0.5, 0.5],
    [0.5, 0.5],
  ] as const) {
    const [ux, uy] = applyAffine(picture, cx, cy);
    const px = box.x + (ux + 0.5) * box.width;
    const py = box.y + (uy + 0.5) * box.height;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Warp fields a composition layer carries (both omitted on the identity path). */
export interface LayerWarpFields {
  /** Composed inverse warp (`stab ∘ picture⁻¹`) in the layer rect's centred UV. */
  warpMatrix?: Affine2x3;
  /**
   * Forward authored transform. Present only when it is not identity; its
   * presence is what tells a compositor to grow the quad to
   * {@link pictureBounds} and mask samples that land outside the picture.
   */
  pictureMatrix?: Affine2x3;
}

/**
 * Spread-in warp fields for a layer, or nothing at all when both inputs are
 * identity — an absent key keeps plain layers structurally identical to what
 * they were before warps existed.
 */
export function layerWarpFields(
  stab: StabMatrix | undefined,
  picture: PictureTransform,
  box: Size,
  frame: Size,
): LayerWarpFields {
  const authored = isIdentityPictureTransform(picture)
    ? undefined
    : buildPictureTransform(picture, box, frame);
  if (!stab && !authored) return {};
  return {
    warpMatrix: composeLayerWarp(stab, authored),
    ...(authored ? { pictureMatrix: authored } : {}),
  };
}

/** Normalized (0–1 of the canvas) rectangle, as the WebGPU passes take it. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Per-draw warp parameters for the preview shader: the matrix, plus the quad
 * to rasterize when the picture can leave its rect. `dest` is the normalized
 * rect the layer is drawn into.
 */
export function layerWarpDrawParams(
  layer: LayerWarpFields,
  dest: NormalizedRect,
): { warpMatrix?: Affine2x3; warpQuad?: NormalizedRect } {
  if (!layer.warpMatrix) return {};
  if (!layer.pictureMatrix) return { warpMatrix: layer.warpMatrix };
  const bounds = pictureBounds(layer.pictureMatrix, {
    x: dest.x,
    y: dest.y,
    width: dest.w,
    height: dest.h,
  });
  return {
    warpMatrix: layer.warpMatrix,
    warpQuad: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
  };
}

/** Both sides of a transition, in the shape `TransitionRenderParams` takes. */
export function transitionWarpParams(
  from: LayerWarpFields,
  to: LayerWarpFields,
): {
  fromWarpMatrix?: Affine2x3;
  toWarpMatrix?: Affine2x3;
  fromWarpMasked?: boolean;
  toWarpMasked?: boolean;
} {
  return {
    fromWarpMatrix: from.warpMatrix,
    toWarpMatrix: to.warpMatrix,
    fromWarpMasked: Boolean(from.pictureMatrix),
    toWarpMasked: Boolean(to.pictureMatrix),
  };
}

/** Write a warp into a flat uniform buffer at `offset` (identity when omitted). */
export function packWarpUniforms(
  buffer: Float32Array,
  offset: number,
  m: Affine2x3 | undefined,
): void {
  const warp = m ?? IDENTITY_AFFINE;
  for (let i = 0; i < 6; i++) buffer[offset + i] = warp[i]!;
}

// ---------------------------------------------------------------------------
// FFmpeg fallback
// ---------------------------------------------------------------------------

/** A picture transform expressed as FFmpeg `scale` / flips / `rotate`. */
export interface FfmpegPictureFilters {
  /** Filter segments, in chain order. */
  filters: string[];
  /** Top-left of the transformed picture's bounding box, in output pixels. */
  x: number;
  y: number;
  /** Size of the bounding box the chain produces. */
  width: number;
  height: number;
}

function evenCeil(value: number): number {
  return Math.max(2, 2 * Math.ceil(value / 2 - 1e-6));
}

/**
 * `scale` + `rotate` for a picture of `box` size placed at `box.x/y` on a
 * `frame`-sized canvas. The chain's output is the transformed picture's
 * bounding box (even dimensions, as yuv420p needs), centred where the GPU
 * path puts it; the caller overlays it at `x`/`y`.
 *
 * `fill` is the `rotate` corner colour: `none` keeps the corners transparent
 * (requires an alpha format upstream), `black` suits an opaque base layer.
 */
export function buildFfmpegPictureFilters(
  t: PictureTransform,
  box: Rect,
  frame: Size,
  fill: 'none' | 'black' = 'none',
): FfmpegPictureFilters {
  const forward = buildPictureTransform(t, box, frame);
  const bounds = pictureBounds(forward, box);
  const sx = safeScale(t.scaleX);
  const sy = safeScale(t.scaleY);
  const scaledW = evenCeil(box.width * Math.abs(sx));
  const scaledH = evenCeil(box.height * Math.abs(sy));
  const outW = evenCeil(bounds.width);
  const outH = evenCeil(bounds.height);
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;

  const filters = [`scale=${scaledW}:${scaledH}`];
  if (sx < 0) filters.push('hflip');
  if (sy < 0) filters.push('vflip');
  if (t.rotation !== 0 || outW !== scaledW || outH !== scaledH) {
    filters.push(
      `rotate=${t.rotation.toFixed(6)}:ow=${outW}:oh=${outH}:c=${fill}`,
    );
  }
  return {
    filters,
    x: Math.round(centreX - outW / 2),
    y: Math.round(centreY - outH / 2),
    width: outW,
    height: outH,
  };
}

/**
 * Chain that places a transformed full-frame picture back onto a
 * `frame`-sized opaque canvas (the base layer has no `overlay` step to
 * position it): scale/rotate, crop to the visible window, pad with black.
 */
export function buildFfmpegFramePictureFilters(
  t: PictureTransform,
  frame: Size,
): string[] {
  const placed = buildFfmpegPictureFilters(
    t,
    { x: 0, y: 0, width: frame.width, height: frame.height },
    frame,
    'black',
  );
  const x0 = Math.max(0, placed.x);
  const y0 = Math.max(0, placed.y);
  const x1 = Math.min(frame.width, placed.x + placed.width);
  const y1 = Math.min(frame.height, placed.y + placed.height);
  if (x1 - x0 < 2 || y1 - y0 < 2) {
    // Picture moved fully off-frame: keep the stream, show black.
    return ['drawbox=c=black:t=fill'];
  }
  // Even crop size and offsets so yuv420p chroma stays aligned.
  const cropW = Math.floor((x1 - x0) / 2) * 2;
  const cropH = Math.floor((y1 - y0) / 2) * 2;
  const padX = Math.floor(x0 / 2) * 2;
  const padY = Math.floor(y0 / 2) * 2;
  return [
    ...placed.filters,
    `crop=${cropW}:${cropH}:${x0 - placed.x}:${y0 - placed.y}`,
    `pad=${frame.width}:${frame.height}:${padX}:${padY}:black`,
  ];
}
