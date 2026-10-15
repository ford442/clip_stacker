#pragma once

#include "cs_status.h"

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

/**
 * Insert-effect rows on an fx mix entry (`MIX_FLAG_EFFECTS`): three more
 * doubles after the legacy twelve. Only `mix_fx_session_range` reads them.
 */
enum {
  /** First row of this entry's insert chain in the session's effect blob. */
  MIX_ENTRY_FX_FIRST = 12,
  MIX_ENTRY_FX_COUNT = 13,
  /** Stable index (the schedule position) of this entry's filter state in the session. */
  MIX_ENTRY_FX_STATE = 14,
  MIX_ENTRY_FX_STRIDE = 15,
};

/**
 * Packed effect block: ten doubles. Fields a kind does not use are ignored.
 *
 *   EQ (peaking / shelves / high-pass): FREQ (Hz), GAIN_DB, Q.
 *   Compressor: THRESHOLD_DB, RATIO (n:1), ATTACK / RELEASE (s), KNEE_DB,
 *     GAIN_DB as make-up gain.
 *   Limiter: THRESHOLD_DB as the ceiling (dBFS), ATTACK as look-ahead (s),
 *     RELEASE (s).
 */
enum {
  MIX_FX_KIND = 0,
  /** 0 = bypassed (the block is skipped, as if absent). */
  MIX_FX_ENABLED = 1,
  MIX_FX_FREQ = 2,
  MIX_FX_GAIN_DB = 3,
  MIX_FX_Q = 4,
  MIX_FX_THRESHOLD_DB = 5,
  MIX_FX_RATIO = 6,
  MIX_FX_ATTACK = 7,
  MIX_FX_RELEASE = 8,
  MIX_FX_KNEE_DB = 9,
  MIX_FX_STRIDE = 10,
};

/** `MIX_FX_KIND` codes. Unknown kinds are skipped. */
enum {
  MIX_FX_PEAKING = 1,
  MIX_FX_LOW_SHELF = 2,
  MIX_FX_HIGH_SHELF = 3,
  MIX_FX_HIGH_PASS = 4,
  MIX_FX_COMPRESSOR = 5,
  /** Bus only (`mix_fx_session_create`); ignored on a clip. */
  MIX_FX_LIMITER = 6,
};

enum {
  /** EQ bands evaluated per clip; later EQ blocks are ignored. */
  MIX_FX_MAX_EQ_BANDS = 4,
  /** Compressors evaluated per clip; later ones are ignored. */
  MIX_FX_MAX_COMPRESSORS = 1,
  /** Look-ahead cap (s); 20 ms at 48 kHz is 960 frames of delay line. */
  MIX_FX_MAX_LOOKAHEAD_MS = 20,
};

enum {
  /** Debug / fallback: phase-1 linear interpolation instead of polyphase sinc. */
  MIX_FLAG_LINEAR_RESAMPLE = 1,
  /**
   * Entries are `MIX_ENTRY_FX_STRIDE` doubles and carry insert chains. Only
   * valid on `mix_fx_session_range`; `mix_timeline_audio_range` rejects it.
   */
  MIX_FLAG_EFFECTS = 2,
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
 * produces bit-identical PCM. `pcm_blob` holds `pcm_floats` floats; every
 * slice an entry reads must lie inside it. `slices` is
 * `slice_count * MIX_SLICE_STRIDE` ints, `entries` is
 * `entry_count * MIX_ENTRY_STRIDE` doubles, `keyframes` is
 * `keyframe_count * MIX_KEY_STRIDE` doubles. Entries whose slice index is out
 * of range are skipped. `flags` is a mask of `MIX_FLAG_*`.
 *
 * Returns a `cs_status`: CS_EINVAL for bad arguments, CS_ERANGE when a slice
 * runs past `pcm_floats` or a curve past `keyframe_count`.
 */
int mix_timeline_audio_range(
    float* out,
    int out_frames,
    int start_frame,
    int out_sample_rate,
    int out_channels,
    const float* pcm_blob,
    int pcm_floats,
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
    int pcm_floats,
    const int* slices,
    int slice_count,
    const double* entries,
    int entry_count,
    const double* keyframes,
    int keyframe_count,
    int flags);

/**
 * Stateful mix with insert effects and an optional bus limiter.
 *
 * Biquads, compressors and the limiter carry state from one frame to the
 * next, so unlike `mix_timeline_audio_range` an fx mix is a function of the
 * whole history: a session must be fed contiguous ranges starting at frame 0.
 * Chunked and whole mixes are still bit-identical, because every entry and
 * the limiter process the same frames in the same order either way.
 *
 * Per clip the chain runs after resampling and before the volume curve, fades
 * and pan: resample -> EQ bands -> compressor -> gain -> pan -> bus. The
 * limiter runs on the summed bus with `mix_fx_session_latency` frames of
 * look-ahead; the session hides that delay, so output frame N is still
 * timeline frame N.
 */
typedef struct MixFxSession MixFxSession;

/**
 * `effects` is `effect_count * MIX_FX_STRIDE` doubles (copied); entries point
 * into it with `MIX_ENTRY_FX_FIRST` / `MIX_ENTRY_FX_COUNT`. Rows
 * `[bus_first, bus_first + bus_count)` are the bus chain (one limiter is
 * honoured). `state_count` bounds `MIX_ENTRY_FX_STATE`. Null on bad arguments
 * or OOM.
 */
MixFxSession* mix_fx_session_create(
    int out_sample_rate,
    int out_channels,
    int state_count,
    const double* effects,
    int effect_count,
    int bus_first,
    int bus_count);

void mix_fx_session_destroy(MixFxSession* session);

/**
 * Look-ahead in frames (0 without an enabled limiter). The bus mixes entries
 * this far ahead of the output: a call for output `[start, start + n)` reads
 * entries over bus frames `[0, n + latency)` on the first call and
 * `[start + latency, start + n + latency)` after that. Upload source slices
 * for that bus range.
 */
int mix_fx_session_latency(const MixFxSession* session);

/**
 * Like `mix_timeline_audio_range`, with entries `MIX_ENTRY_FX_STRIDE` wide
 * when `flags & MIX_FLAG_EFFECTS` (legacy twelve otherwise, which still runs
 * the bus limiter). `start_frame` must equal the previous call's end (0
 * first); anything else returns CS_ESTATE. CS_ENOMEM if the bus buffer
 * cannot grow. Output and channel count come from the session.
 */
int mix_fx_session_range(
    MixFxSession* session,
    float* out,
    int out_frames,
    int start_frame,
    const float* pcm_blob,
    int pcm_floats,
    const int* slices,
    int slice_count,
    const double* entries,
    int entry_count,
    const double* keyframes,
    int keyframe_count,
    int flags);

/**
 * A clip insert chain on its own, for the preview's processed buffers: the
 * same `InsertChain` the fx mix runs per entry, fed planar PCM in blocks.
 *
 * `design_sample_rate` is the rate coefficients are designed at: pass
 * `sample_rate * playback_rate`, so a sped-up source gets the export mix's
 * output-domain EQ frequencies and time constants. Null on bad arguments.
 */
typedef struct MixInsertChain MixInsertChain;

MixInsertChain* insert_chain_create(double design_sample_rate, const double* effects, int effect_count);

/**
 * Process `frames` frames in place (`channels` planes of `frames` floats, 1 or
 * 2), continuing from the previous call's state, so any blocking gives the
 * same samples. Returns 0, or negative on bad arguments.
 */
int insert_chain_process(MixInsertChain* chain, float* planar, int frames, int channels);

void insert_chain_destroy(MixInsertChain* chain);

#ifdef __cplusplus
}
#endif
