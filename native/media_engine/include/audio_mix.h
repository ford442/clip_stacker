#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/** Packed clip metadata: four int32s per clip. */
enum {
  MIX_CLIP_PCM_OFFSET = 0,
  MIX_CLIP_FRAMES = 1,
  MIX_CLIP_CHANNELS = 2,
  MIX_CLIP_SAMPLE_RATE = 3,
  MIX_CLIP_STRIDE = 4,
};

/** Packed mix entry: eight floats per schedule row. */
enum {
  MIX_ENTRY_CLIP_INDEX = 0,
  MIX_ENTRY_TIMELINE_START = 1,
  MIX_ENTRY_DURATION = 2,
  MIX_ENTRY_BUFFER_OFFSET = 3,
  MIX_ENTRY_VOLUME = 4,
  MIX_ENTRY_FADE_IN = 5,
  MIX_ENTRY_FADE_OUT = 6,
  MIX_ENTRY_PLAYBACK_RATE = 7,
  MIX_ENTRY_STRIDE = 8,
};

/**
 * Mix scheduled clips into interleaved f32 PCM.
 *
 * `out` is `out_frames * out_channels` (1 or 2). `pcm_blob` is concatenated
 * interleaved clip audio. `clip_meta` is `clip_count * MIX_CLIP_STRIDE` ints.
 * `entries` is `entry_count * MIX_ENTRY_STRIDE` floats.
 *
 * Returns 0 on success, negative on invalid arguments.
 */
int mix_timeline_audio(
    float* out,
    int out_frames,
    int out_sample_rate,
    int out_channels,
    const float* pcm_blob,
    const int* clip_meta,
    int clip_count,
    const float* entries,
    int entry_count);

#ifdef __cplusplus
}
#endif
