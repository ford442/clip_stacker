#pragma once

// Source-frame interpolation for the timeline mixer.
//
// Phase 2 default: windowed-sinc polyphase FIR (Kaiser window, coefficient
// interpolation between phases, cutoff scaled down when the step decimates).
// Linear interpolation is kept as the debug / fallback path
// (`MIX_FLAG_LINEAR_RESAMPLE`).

namespace media_engine {

/** Taps on each side of the interpolated position (64-tap FIR). */
constexpr int kSincHalfTaps = 32;
constexpr int kSincTaps = 2 * kSincHalfTaps;
/** Polyphase rows per unit of source-frame fraction (plus one guard row). */
constexpr int kSincPhases = 512;
/** Passband edge as a fraction of the (output-limited) Nyquist frequency. */
constexpr double kSincRolloff = 0.945;
/** Kaiser window beta (~100 dB stopband). */
constexpr double kSincKaiserBeta = 10.0;

/**
 * One planar channel of clip audio, addressed by absolute clip frame.
 * `data[i - first_frame]` is clip frame `i`; frames outside
 * `[first_frame, first_frame + frame_count)` read as silence.
 */
struct SourceSlice {
  const float* data;
  int first_frame;
  int frame_count;
};

/** Anti-imaging / anti-aliasing cutoff for a source step (source frames per output frame). */
double sinc_cutoff_for_step(double step);

/**
 * Polyphase rows for `cutoff` (fraction of source Nyquist). Row `p` (0..kSincPhases)
 * holds `kSincTaps` coefficients for fractional position `p / kSincPhases`; each row
 * sums to 1. Tables are cached (a few slots), so repeat calls are cheap.
 */
const float* sinc_table(double cutoff);

/**
 * Interpolate `channels` (1 or 2) planar slices at fractional clip frame `pos`
 * with the polyphase table `rows`. Writes `channels` samples to `out`.
 */
void resample_sinc(
    const SourceSlice* slices,
    int channels,
    double pos,
    const float* rows,
    float* out);

/**
 * Linear (phase-1) interpolation between `floor(pos)` and the next frame,
 * clamped to `clip_frames - 1`. Writes `channels` samples to `out`.
 */
void resample_linear(
    const SourceSlice* slices,
    int channels,
    double pos,
    int clip_frames,
    float* out);

/** Sample clip frame `frame` from a slice (0 outside the slice). */
inline float slice_sample(const SourceSlice& slice, int frame) {
  const int local = frame - slice.first_frame;
  if (local < 0 || local >= slice.frame_count) return 0.f;
  return slice.data[local];
}

}  // namespace media_engine
