#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Linear (phase-1) interpolation of one output stereo frame from interleaved
 * source PCM. `src_frame` is a fractional source-frame index.
 *
 * Mono sources are copied to both channels. Reads past the last frame return 0.
 */
void resample_linear_stereo(
    const float* interleaved,
    int frames,
    int channels,
    float src_frame,
    float* out_l,
    float* out_r);

#ifdef __cplusplus
}
#endif
