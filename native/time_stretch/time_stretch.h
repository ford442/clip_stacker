#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Pitch-preserving WSOLA time remap.
 *
 * Input is planar float32 (channel 0 contiguous, then channel 1, …).
 * `source_offsets` maps each output hop center (hop_index * hop) to a
 * fractional source-frame position (relative to the start of `input`).
 * Output length is `out_frames` per channel.
 *
 * Returns 0 on success, non-zero on invalid args.
 */
int time_stretch_remap(
    const float* input,
    int in_frames,
    int channels,
    const float* source_offsets,
    int num_offsets,
    int hop,
    float* output,
    int out_frames);

/** Constant-tempo WSOLA: tempo > 1 plays faster (shorter output). */
int time_stretch_constant(
    const float* input,
    int in_frames,
    int channels,
    float tempo,
    float* output,
    int out_frames,
    int hop);

#ifdef __cplusplus
}
#endif
