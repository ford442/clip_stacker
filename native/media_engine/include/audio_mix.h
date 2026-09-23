#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Packed source-slice metadata: six int32s per slice.
 *
 * A slice is a window of one clip's planar PCM (channel `c` starts at
 * `pcm_blob + PCM_OFFSET + c * FRAMES`). Streaming callers upload only the
 * frames a chunk reads, plus `MIX_SOURCE_MARGIN_FRAMES` on each side.
 */
enum {
  MIX_SLICE_PCM_OFFSET = 0,
  MIX_SLICE_FRAMES = 1,
  MIX_SLICE_CHANNELS = 2,
  MIX_SLICE_SAMPLE_RATE = 3,
  /** Absolute clip frame of the slice's first sample. */
  MIX_SLICE_FIRST_FRAME = 4,
  /** Full clip length in frames (reads at or past it are silence). */
  MIX_SLICE_CLIP_FRAMES = 5,
  MIX_SLICE_STRIDE = 6,
};

/**
 * Packed mix entry: twelve doubles per schedule row (f64 so a 2-hour
 * timeline keeps sample-accurate start times).
 */
enum {
  MIX_ENTRY_SLICE_INDEX = 0,
  MIX_ENTRY_TIMELINE_START = 1,
  MIX_ENTRY_DURATION = 2,
  MIX_ENTRY_BUFFER_OFFSET = 3,
  /** Linear gain when there is no volume curve (already ducked + clamped). */
  MIX_ENTRY_VOLUME = 4,
  MIX_ENTRY_FADE_IN = 5,
  MIX_ENTRY_FADE_OUT = 6,
  MIX_ENTRY_PLAYBACK_RATE = 7,
  /** First keyframe row of the volume curve in `keyframes`. */
  MIX_ENTRY_VOLUME_KEYS = 8,
  MIX_ENTRY_VOLUME_KEY_COUNT = 9,
  MIX_ENTRY_PAN_KEYS = 10,
  MIX_ENTRY_PAN_KEY_COUNT = 11,
  MIX_ENTRY_STRIDE = 12,
};

/**
 * Packed keyframe: seven doubles, sorted by time within each curve. Mirrors
 * `Keyframe` / `sampleKeyframes` in `src/utils/keyframes.ts` (clip-local seconds).
 */
enum {
  MIX_KEY_TIME = 0,
  MIX_KEY_VALUE = 1,
  MIX_KEY_EASING = 2,
  MIX_KEY_X1 = 3,
  MIX_KEY_Y1 = 4,
  MIX_KEY_X2 = 5,
  MIX_KEY_Y2 = 6,
  MIX_KEY_STRIDE = 7,
};

/** `KeyframeEasing.type` codes. */
enum {
  MIX_EASING_LINEAR = 0,
  MIX_EASING_BEZIER = 1,
  MIX_EASING_BELL_SMOOTH = 2,
  MIX_EASING_BELL_SHARP = 3,
};

enum {
  /** Debug / fallback: phase-1 linear interpolation instead of polyphase sinc. */
  MIX_FLAG_LINEAR_RESAMPLE = 1,
};

enum {
  /** Source frames a slice must carry beyond the frames a chunk reads. */
  MIX_SOURCE_MARGIN_FRAMES = 64,
  /** Volume-curve clamp (`MAX_CLIP_VOLUME` in `src/utils/audioVolume.ts`). */
  MIX_VOLUME_MAX = 2,
};

/**
 * Mix output frames `[start_frame, start_frame + out_frames)` of the timeline
 * into interleaved f32 `out` (`out_frames * out_channels`, 1 or 2 channels).
 *
 * Every output frame is a pure function of its absolute index, so any chunking
 * produces bit-identical PCM. `slices` is `slice_count * MIX_SLICE_STRIDE`
 * ints, `entries` is `entry_count * MIX_ENTRY_STRIDE` doubles, `keyframes` is
 * `keyframe_count * MIX_KEY_STRIDE` doubles. Entries whose slice index is out
 * of range are skipped. `flags` is a mask of `MIX_FLAG_*`.
 *
 * Returns 0 on success, negative on invalid arguments.
 */
int mix_timeline_audio_range(
    float* out,
    int out_frames,
    int start_frame,
    int out_sample_rate,
    int out_channels,
    const float* pcm_blob,
    const int* slices,
    int slice_count,
    const double* entries,
    int entry_count,
    const double* keyframes,
    int keyframe_count,
    int flags);

/** Whole-timeline convenience: `mix_timeline_audio_range` from frame 0. */
int mix_timeline_audio(
    float* out,
    int out_frames,
    int out_sample_rate,
    int out_channels,
    const float* pcm_blob,
    const int* slices,
    int slice_count,
    const double* entries,
    int entry_count,
    const double* keyframes,
    int keyframe_count,
    int flags);

#ifdef __cplusplus
}
#endif
