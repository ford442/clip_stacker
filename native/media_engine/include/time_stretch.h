#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Pitch-preserving WSOLA time remap (playbackRate automation curves).
 *
 * `input` is planar f32 (`channels` planes of `in_frames`), `output` planar
 * f32 (`channels` planes of `out_frames`). `source_offsets[h]` is the
 * fractional source frame (relative to `input[0]`) heard at output frame
 * `h * hop`; doubles, so a long clip keeps sub-sample positions. The caller
 * supplies `ceil(out_frames / hop) + 1` offsets to cover the whole output;
 * output past the last offset is silence.
 *
 * Each synthesis segment is a `2 * hop` periodic-Hann window at 50% overlap.
 * Its source position may move up to `tolerance` frames from the nominal
 * offset, to wherever its first half best matches (normalized
 * cross-correlation) the natural continuation of the previous segment, so
 * overlapping segments add in phase instead of comb-filtering. `tolerance`
 * 0 is plain OLA; negative selects the default, `hop / 2`. Fractional source
 * positions are read with the mixer's 64-tap polyphase sinc; integral ones
 * are copied, so rate 1 reproduces the input bit for bit.
 *
 * `hop` is clamped to [64, 4096] and `tolerance` to [0, hop]. Reads outside
 * the input are silence. Returns a `cs_status`: CS_EINVAL for bad arguments
 * or a non-finite offset, CS_ENOMEM if the window table cannot be allocated.
 */
int time_stretch_remap(
    const float* input,
    int in_frames,
    int channels,
    const double* source_offsets,
    int num_offsets,
    int hop,
    int tolerance,
    float* output,
    int out_frames);

#ifdef __cplusplus
}
#endif
