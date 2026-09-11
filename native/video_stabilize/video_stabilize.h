#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Sparse-optical-flow video stabilization.
 *
 * Usage is strictly two-phase:
 *
 *   h = stab_create(w, h, radius);
 *   for each frame:  stab_push_frame(h, gray);     // analysis
 *   stab_finalize(h);                              // smooth the trajectory
 *   for each frame:  stab_get_matrix(h, i, m);     // correction matrices
 *   stab_destroy(h);
 *
 * `stab_finalize` exists because the trajectory smoother is a *centred*
 * moving average: the correction for frame i depends on frames up to
 * i + smoothRadius, so no correction is knowable until every frame is in.
 * Calling stab_get_matrix / stab_apply_warp before finalizing yields identity.
 */

typedef struct StabHandle StabHandle;

/** Rows of the 2x3 matrix stab_get_matrix writes. */
#define STAB_MATRIX_FLOATS 6

/**
 * Allocate a stabilizer for `width` x `height` grayscale input.
 * `smooth_radius` is the half-width of the moving average, in frames
 * (clamped to [1, 120]); larger is smoother but lags real camera moves more.
 * Returns NULL on invalid arguments.
 */
StabHandle* stab_create(int width, int height, int smooth_radius);

/**
 * Push one frame of 8-bit grayscale (`width * height` bytes, row-major).
 * Frames must arrive in presentation order. Returns the index assigned to
 * this frame, or -1 if the handle is finalized or the pointer is null.
 */
int stab_push_frame(StabHandle* handle, const uint8_t* gray);

/** Number of frames pushed so far. */
int stab_frame_count(const StabHandle* handle);

/**
 * Smooth the accumulated trajectory and build the per-frame corrections.
 * Idempotent. Returns 0 on success, non-zero if there is nothing to smooth.
 */
int stab_finalize(StabHandle* handle);

/**
 * Write frame `frame_idx`'s correction as a 2x3 affine into `out`, laid out
 * `[a, b, tx, c, d, ty]`.
 *
 * The matrix is an INVERSE warp in normalized UV space, centred on the frame:
 *
 *   uvSrc.x = a * (uvDst.x - 0.5) + b * (uvDst.y - 0.5) + 0.5 + tx
 *   uvSrc.y = c * (uvDst.x - 0.5) + d * (uvDst.y - 0.5) + 0.5 + ty
 *
 * so it can be handed straight to a shader UV lookup. Identity is
 * `[1, 0, 0, 0, 1, 0]`. Frame aspect ratio is already folded into b and c,
 * and the auto-crop zoom (see stab_get_zoom) into a, b, c, d.
 *
 * Out-of-range indices and un-finalized handles yield identity.
 */
void stab_get_matrix(const StabHandle* handle, int frame_idx, float* out);

/**
 * Crop factor baked into the correction matrices (>= 1.0). Warping exposes
 * empty edges; the corrections zoom in by this much so those edges stay off
 * screen. 1.0 means the footage needed no crop.
 */
float stab_get_zoom(const StabHandle* handle);

/** Peak correction magnitude, in fractions of frame width (diagnostics / UI). */
float stab_get_max_correction(const StabHandle* handle);

/**
 * Warp one RGBA frame with frame `frame_idx`'s correction.
 * `rgba_in` and `rgba_out` are both `width * height * 4` bytes and must not
 * overlap. Sampling is bilinear; out-of-frame reads clamp to the edge.
 */
void stab_apply_warp(
    const StabHandle* handle,
    const uint8_t* rgba_in,
    uint8_t* rgba_out,
    int frame_idx);

/** Free the handle. Safe on NULL. */
void stab_destroy(StabHandle* handle);

#ifdef __cplusplus
}
#endif
