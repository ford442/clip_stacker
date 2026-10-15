/**
 * Status codes and bounds checks shared by every clip_stacker WASM module.
 *
 * Every `int`-returning entry point returns a `cs_status`: 0 on success,
 * negative on failure. JS reads them through `CS_STATUS` in
 * `src/wasm/emscriptenLoader.ts`, which mirrors this enum.
 */
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

enum cs_status {
  CS_OK = 0,
  /** A null pointer, negative count, or out-of-range parameter. */
  CS_EINVAL = -1,
  /** An allocation failed. The module stays usable; the caller can fall back. */
  CS_ENOMEM = -2,
  /** Called out of order (non-contiguous fx range, push after finalize, …). */
  CS_ESTATE = -3,
  /** An offset or length points outside the buffer it names. */
  CS_ERANGE = -4,
  /** An internal invariant broke; a bug, not bad input. */
  CS_EINTERNAL = -5,
};

/**
 * True when `[offset, offset + count)` lies inside a buffer of `size`
 * elements. 64-bit arithmetic, so int32 arguments from JS cannot overflow.
 */
static inline int cs_span_ok(long long offset, long long count, long long size) {
  return offset >= 0 && count >= 0 && size >= 0 && offset <= size && count <= size - offset;
}

#ifdef __cplusplus
}
#endif
