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

/**
 * Chunked form of `time_stretch_remap`, for clips too long to hold in the
 * WASM heap (a 10 minute stereo clip is 230 MB of f32). Output is produced
 * hop-aligned chunk by chunk, each from a window of the source; the carried
 * state is one segment, so chunked output equals `time_stretch_remap` bit
 * for bit.
 *
 * `source_frames` is the whole source's length (reads outside it are
 * silence). Returns null on bad arguments or OOM.
 */
void* time_stretch_session_create(double source_frames, int channels, int hop, int tolerance);

/**
 * Produce the next `out_frames` of output (a multiple of the clamped hop,
 * except on the final call, which ends the session). `offsets` holds the
 * source offsets of output frames `k * hop` for this chunk's blocks plus one
 * (`out_frames / hop + 1` of them, fewer when the curve ends: output past
 * the last offset is silence, as in `time_stretch_remap`). `window` is
 * planar f32, `window_frames` per channel, holding source frames
 * `[window_start, window_start + window_frames)`; it must cover
 * `[min(offsets) - 2 * hop - tolerance - 64, max(offsets) + 2 * hop +
 * tolerance + 64)` clipped to the source, else CS_ERANGE (and nothing is
 * written). CS_ESTATE after the final call.
 */
int time_stretch_session_process(
    void* session,
    const float* window,
    int window_frames,
    double window_start,
    const double* offsets,
    int num_offsets,
    float* output,
    int out_frames);

/** The clamped synthesis hop the session runs at. */
int time_stretch_session_hop(const void* session);

void time_stretch_session_destroy(void* session);

#ifdef __cplusplus
}
#endif
