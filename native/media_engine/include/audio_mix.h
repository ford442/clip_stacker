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
 * Insert-effect rows on an fx mix entry (`MIX_FLAG_EFFECTS`): four more
 * doubles after the legacy twelve. Only the fx session reads them.
 */
enum {
  /** First row of this entry's insert chain in the session's effect blob. */
  MIX_ENTRY_FX_FIRST = 12,
  MIX_ENTRY_FX_COUNT = 13,
  /** Stable index (the schedule position) of this entry's filter state in the session. */
  MIX_ENTRY_FX_STATE = 14,
  /**
   * Lane bus the entry mixes into (`mix_bus_session_create`). Out of range
   * (e.g. -1) = straight to the master sum, delay-compensated like a lane.
   */
  MIX_ENTRY_FX_BUS = 15,
  MIX_ENTRY_FX_STRIDE = 16,
};

/**
 * Packed effect block: thirteen doubles. Fields a kind does not use are
 * ignored.
 *
 *   EQ (peaking / shelves / high-pass / low-pass): FREQ (Hz), GAIN_DB, Q.
 *   Compressor: THRESHOLD_DB, RATIO (n:1), ATTACK / RELEASE (s), KNEE_DB,
 *     GAIN_DB as make-up gain.
 *   Limiter (true peak): THRESHOLD_DB as the ceiling (dBTP), ATTACK as
 *     look-ahead (s), RELEASE (s).
 *   Gate: THRESHOLD_DB, RANGE_DB (attenuation when closed), ATTACK (open),
 *     HOLD, RELEASE (close), all seconds.
 *   De-esser: FREQ (split), THRESHOLD_DB (high band), RATIO, RANGE_DB (most
 *     reduction), ATTACK / RELEASE.
 *   Ducker (lane buses only): KEY (bus index of the sidechain lane; must be
 *     packed before the ducked lane), RANGE_DB as the depth, THRESHOLD_DB on
 *     the key, ATTACK / HOLD / RELEASE.
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
  MIX_FX_HOLD = 10,
  MIX_FX_RANGE_DB = 11,
  MIX_FX_KEY = 12,
  MIX_FX_STRIDE = 13,
};

/** `MIX_FX_KIND` codes. Unknown kinds are skipped. */
enum {
  MIX_FX_PEAKING = 1,
  MIX_FX_LOW_SHELF = 2,
  MIX_FX_HIGH_SHELF = 3,
  MIX_FX_HIGH_PASS = 4,
  MIX_FX_COMPRESSOR = 5,
  /** Buses only; ignored on a clip. */
  MIX_FX_LIMITER = 6,
  MIX_FX_LOW_PASS = 7,
  /** Buses only. */
  MIX_FX_GATE = 8,
  /** Buses only. */
  MIX_FX_DEESSER = 9,
  /** Lane buses only: sidechain duck keyed by another lane. */
  MIX_FX_DUCKER = 10,
};

enum {
  /** EQ bands evaluated per clip; later EQ blocks are ignored. */
  MIX_FX_MAX_EQ_BANDS = 4,
  /** Compressors evaluated per clip; later ones are ignored. */
  MIX_FX_MAX_COMPRESSORS = 1,
  /** Look-ahead cap (s); 20 ms at 48 kHz is 960 frames of delay line. */
  MIX_FX_MAX_LOOKAHEAD_MS = 20,
  /** Processing stages per bus chain (each EQ band is one); later rows are ignored. */
  MIX_BUS_MAX_STAGES = 64,
  /** Lane buses per graph. */
  MIX_BUS_MAX_LANES = 32,
};

/**
 * Packed lane bus: two int32s per lane. The lane's chain is rows
 * `[FX_FIRST, FX_FIRST + FX_COUNT)` of the effect blob, processed in order;
 * a `MIX_FX_DUCKER` row among them runs after the chain and after delay
 * compensation (one ducker per lane is honoured).
 */
enum {
  MIX_BUS_FX_FIRST = 0,
  MIX_BUS_FX_COUNT = 1,
  MIX_BUS_STRIDE = 2,
};

/** `flags` for `mix_bus_session_create` / `bus_graph_create`. */
enum {
  /** Run the BS.1770 meter (and gain-reduction readouts) on the output. */
  MIX_BUS_FLAG_METER = 1,
};

/**
 * Meter readout (`bus_graph_meters` / `mix_fx_session_meters`): doubles.
 * Loudness in LUFS (-inf = no signal yet), LRA in LU, peaks in dBTP / dBFS,
 * gain reduction in dB (>= 0, the most since the previous read).
 */
enum {
  MIX_METER_MOMENTARY = 0,
  MIX_METER_SHORT_TERM = 1,
  MIX_METER_INTEGRATED = 2,
  MIX_METER_RANGE = 3,
  MIX_METER_TRUE_PEAK = 4,
  MIX_METER_SAMPLE_PEAK = 5,
  /** Master chain + final limiter. */
  MIX_METER_MASTER_GR = 6,
  /** Then one per lane bus, in packed order. */
  MIX_METER_LANE_GR = 7,
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
 * Stateful mix with insert effects and an optional bus graph.
 *
 * Biquads, compressors, limiters and meters carry state from one frame to the
 * next, so unlike `mix_timeline_audio_range` an fx mix is a function of the
 * whole history: a session must be fed contiguous ranges starting at frame 0.
 * Chunked and whole mixes are still bit-identical, because every entry and
 * every bus processes the same frames in the same order either way.
 *
 * Per clip the chain runs after resampling and before the volume curve, fades
 * and pan: resample -> EQ bands -> compressor -> gain -> pan -> lane bus.
 * The bus graph (see `bus_graph_create`) then runs every lane's chain, delay
 * compensation and sidechain duck, sums the lanes, and runs the master
 * chain, the static output gain and the final limiter. Limiters look ahead
 * (`mix_fx_session_latency` frames in all); the session hides that delay, so
 * output frame N is still timeline frame N.
 */
typedef struct MixFxSession MixFxSession;

/**
 * `effects` is `effect_count * MIX_FX_STRIDE` doubles (copied); entries point
 * into it with `MIX_ENTRY_FX_FIRST` / `MIX_ENTRY_FX_COUNT`. Rows
 * `[bus_first, bus_first + bus_count)` are a final stage after the mix (only
 * an enabled limiter there is honoured). `state_count` bounds
 * `MIX_ENTRY_FX_STATE`. Null on bad arguments or OOM.
 */
MixFxSession* mix_fx_session_create(
    int out_sample_rate,
    int out_channels,
    int state_count,
    const double* effects,
    int effect_count,
    int bus_first,
    int bus_count);

/**
 * A session with lane buses: `buses` is `bus_count * MIX_BUS_STRIDE` ints
 * (copied) and entries route with `MIX_ENTRY_FX_BUS`. `master_*` and
 * `final_*` are row ranges of `effects`: the master chain, then
 * `output_gain_db` (a static gain, e.g. loudness normalization), then the
 * final stage (limiters only). `flags`: `MIX_BUS_FLAG_*`. A layout that
 * processes nothing (no stage, no duck, 0 dB, no meter) runs exactly like
 * `mix_fx_session_create` with no bus rows. Null on bad arguments or OOM.
 */
MixFxSession* mix_bus_session_create(
    int out_sample_rate,
    int out_channels,
    int state_count,
    const double* effects,
    int effect_count,
    const int* buses,
    int bus_count,
    int master_first,
    int master_count,
    double output_gain_db,
    int final_first,
    int final_count,
    int flags);

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
 * when `flags & MIX_FLAG_EFFECTS` (legacy twelve otherwise, which all mix
 * straight to the master sum). `start_frame` must equal the previous call's
 * end (0 first); anything else returns CS_ESTATE. CS_ENOMEM if the bus
 * buffers cannot grow. Output and channel count come from the session.
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
 * Meter readout of a session created with `MIX_BUS_FLAG_METER` (it meters the
 * delivered output, after the final stage): writes up to `capacity` doubles
 * in the `MIX_METER_*` layout and returns how many it wrote (0 without a
 * meter), or a negative `cs_status`.
 */
int mix_fx_session_meters(MixFxSession* session, double* out, int capacity);

/**
 * The bus graph on its own, for the preview's AudioWorklet (the standalone
 * `media_engine_fx.wasm`) — the same `BusGraph` the fx session runs, so
 * preview and export process identical samples. Arguments as for
 * `mix_bus_session_create`. Null on bad arguments or OOM.
 */
typedef struct BusGraphHandle BusGraphHandle;

BusGraphHandle* bus_graph_create(
    int sample_rate,
    int channels,
    const double* effects,
    int effect_count,
    const int* buses,
    int bus_count,
    int master_first,
    int master_count,
    double output_gain_db,
    int final_first,
    int final_count,
    int flags);

/**
 * Retune in place (filter and envelope state kept) when the new layout has
 * the same structure: lane count, stage kinds in order, ducks and limiter
 * look-aheads. CS_ESTATE when it does not (create a new graph instead).
 */
int bus_graph_update(
    BusGraphHandle* graph,
    const double* effects,
    int effect_count,
    const int* buses,
    int bus_count,
    int master_first,
    int master_count,
    double output_gain_db,
    int final_first,
    int final_count);

/** Total look-ahead delay (frames) from lane input to output. */
int bus_graph_latency(const BusGraphHandle* graph);

/**
 * Process `frames` frames. `lanes` holds `bus_count + 1` interleaved blocks
 * of `frames * channels` floats, lane-major; the last block is the direct
 * (unrouted) input. `out` receives `frames * channels` interleaved floats,
 * delayed by `bus_graph_latency` frames (silence while it primes).
 */
int bus_graph_process(BusGraphHandle* graph, const float* lanes, float* out, int frames);

/** As `mix_fx_session_meters`; gain-reduction peaks restart after a read. */
int bus_graph_meters(BusGraphHandle* graph, double* out, int capacity);

/** Restart the integrated / range / peak measurement (the meter's reset). */
void bus_graph_reset_meter(BusGraphHandle* graph);

/** Clear every filter, envelope and delay line (a seek). The meter keeps measuring. */
void bus_graph_reset(BusGraphHandle* graph);

void bus_graph_destroy(BusGraphHandle* graph);

/**
 * ITU-R BS.1770-4 / EBU Tech 3341 loudness meter on its own: K-weighting,
 * momentary (400 ms) and short-term (3 s) windows updated every 100 ms,
 * integrated loudness over 400 ms blocks at 75 % overlap with the -70 LUFS
 * absolute and -10 LU relative gates, loudness range (EBU Tech 3342) and
 * 4x-oversampled true peak. Null on bad arguments.
 */
typedef struct LoudnessMeterHandle LoudnessMeterHandle;

LoudnessMeterHandle* loudness_meter_create(int sample_rate, int channels);

/** Feed `frames` interleaved frames. CS_ENOMEM if the block history cannot grow. */
int loudness_meter_process(LoudnessMeterHandle* meter, const float* interleaved, int frames);

/** Writes up to `capacity` doubles (`MIX_METER_MOMENTARY` .. `MIX_METER_SAMPLE_PEAK`); returns the count. */
int loudness_meter_read(const LoudnessMeterHandle* meter, double* out, int capacity);

void loudness_meter_destroy(LoudnessMeterHandle* meter);

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
