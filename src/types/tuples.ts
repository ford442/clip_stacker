/**
 * Fixed-length numeric tuples shared by the compositor, the finishing passes
 * and the uniform packers. Under `noUncheckedIndexedAccess` a `number[]` read
 * is `number | undefined`; a tuple read at a literal index is `number`, so use
 * these instead of `number[]` + `!` wherever the length is fixed.
 */

/** Two floats: a uv, a pixel size, an x / y pair. */
export type Vec2 = readonly [number, number];

/** Three floats: an RGB triple, a 3D vector. */
export type Vec3 = readonly [number, number, number];

/** Four floats: a vec4 uniform slot. */
export type Vec4 = readonly [number, number, number, number];

/** Straight (non-premultiplied) RGBA, each channel 0–1 unless stated. */
export type Rgba = readonly [number, number, number, number];

/**
 * A 2x3 affine `[a, b, tx, c, d, ty]` (row-major, the last column the
 * translation). The warp matrices of stabilization, the clip picture
 * transform, the transition template and Canvas2D all use this layout: an
 * inverse warp that maps an output UV to the source UV it samples, about the
 * rect centre.
 */
export type Mat2x3 = readonly [number, number, number, number, number, number];
