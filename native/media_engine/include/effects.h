#pragma once

// Insert and bus effects for the media-engine mix: RBJ-cookbook biquads, a
// feed-forward soft-knee compressor, a gate, a split-band de-esser, a
// sidechain ducker and a true-peak look-ahead limiter. Internal C++ API; the
// packed rows they are built from are documented in audio_mix.h.
//
// Every recursive path flushes values below 1e-30 to zero: WASM has no
// FTZ / DAZ mode, so a tail decaying in silence would otherwise crawl
// through subnormal arithmetic (tens of times slower per sample).

#include "resampler.h"

#include <cmath>
#include <vector>

namespace media_engine {

/**
 * Zero for |v| < 1e-30 (see the note above), and for NaN: `!(|v| >= 1e-30)`
 * is true for NaN, so recursive state that once went NaN recovers on the next
 * sample instead of staying NaN for the rest of the session.
 */
inline double flush_denormal(double v) { return !(std::fabs(v) >= 1e-30) ? 0.0 : v; }

/**
 * The same on a sample between stages: an f32 below 1e-30 (-600 dBFS) is
 * zeroed, so a filter's decaying tail fed through further cuts cannot reach
 * the next stage (or the output) as a subnormal; a NaN or an infinity is
 * zeroed too (the limiter's policy), so it stops here instead of reaching
 * every stage after it.
 */
inline float flush_sample(float v) {
  const float a = std::fabs(v);
  return a >= 1e-30f && a <= 3.40282347e+38f ? v : 0.f;
}

/**
 * Control period (frames) of the dynamics' gain computers. The compressor
 * and the de-esser need a log10 (and a pow, or a shelf redesign) per update,
 * so they update every `kControlFrames` frames on the block's peak and
 * interpolate linearly in between. Block boundaries are frame counts since
 * the stage was built or reset, so the output never depends on how the
 * caller chunked its audio, and preview and export (the same C++) still
 * null bit for bit.
 */
constexpr int kControlFrames = 16;

/**
 * 20 * log10(x) for x > 0 without a libm transcendental: frexp splits off the
 * exponent and an atanh series on the mantissa (in [1/sqrt 2, sqrt 2)) gives
 * ln to ~3e-8, i.e. ~2e-7 dB. Plain arithmetic, so it is cheap enough for a
 * per-frame detector and gives the same bits under glibc and musl (WASM).
 */
inline double amplitude_db(double x) {
  int e = 0;
  double m = std::frexp(x, &e);
  if (m < 0.70710678118654752) {
    m *= 2.0;
    --e;
  }
  const double z = (m - 1.0) / (m + 1.0);
  const double z2 = z * z;
  const double ln_m = 2.0 * z * (1.0 + z2 * (1.0 / 3.0 + z2 * (1.0 / 5.0 + z2 * (1.0 / 7.0 + z2 * (1.0 / 9.0)))));
  return 8.6858896380650366 * (ln_m + static_cast<double>(e) * 0.69314718055994531);
}

/** One RBJ Audio EQ Cookbook section, transposed direct form II, f64 state. */
class Biquad {
 public:
  /**
   * Design from a packed `MIX_FX_*` row at `sample_rate`. False for a non-EQ
   * kind. `keep_state` retunes without clearing the filter memory.
   */
  bool design(const double* row, double sample_rate, bool keep_state = false);

  /** Raw coefficients (already divided by a0); used by the K-weighting filter. Clears the state. */
  void set(double b0, double b1, double b2, double a1, double a2);

  /** Coefficients as {b0, b1, b2, a1, a2}. */
  void coefficients(double* out) const {
    out[0] = b0_;
    out[1] = b1_;
    out[2] = b2_;
    out[3] = a1_;
    out[4] = a2_;
  }

  /** Replace the coefficients ({b0, b1, b2, a1, a2}) and keep the filter memory. */
  void assign(const double* c) {
    b0_ = c[0];
    b1_ = c[1];
    b2_ = c[2];
    a1_ = c[3];
    a2_ = c[4];
  }

  void reset() { z1_[0] = z1_[1] = z2_[0] = z2_[1] = 0.0; }

  double process_d(int channel, double x) {
    double& z1 = z1_[channel];
    double& z2 = z2_[channel];
    const double y = b0_ * x + z1;
    z1 = flush_denormal(b1_ * x - a1_ * y + z2);
    z2 = flush_denormal(b2_ * x - a2_ * y);
    return y;
  }

  float process(int channel, float x) { return static_cast<float>(process_d(channel, x)); }

  /** |H(e^jw)| in dB at `freq` — what the host tests compare against. */
  double magnitude_db(double freq, double sample_rate) const;

 private:
  double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
  double z1_[2] = {0, 0};
  double z2_[2] = {0, 0};
};

/**
 * Feed-forward compressor (Giannoulis, Massberg & Reiss 2012): soft-knee gain
 * computer in dB, smooth branching peak detector on the gain, stereo linked on
 * the louder channel. The detector and smoother run every frame in dB (with
 * `amplitude_db`, no libm call); the dB -> linear conversion runs at control
 * rate (`kControlFrames`), and the linear gain ramps to each new value over
 * the next block.
 */
class Compressor {
 public:
  bool design(const double* row, double sample_rate, bool keep_state = false);

  /** Gain to apply to the frame whose louder channel has magnitude `peak`. */
  float gain(float peak) {
    const double x_db = peak > 1e-6f ? amplitude_db(static_cast<double>(peak)) : -120.0;
    const double target = static_curve(x_db) - x_db;  // <= 0
    const double coef = target < gain_db_ ? attack_coef_ : release_coef_;
    gain_db_ = flush_denormal(coef * gain_db_ + (1.0 - coef) * target);
    if (-gain_db_ > peak_db_) peak_db_ = -gain_db_;
    if (++pos_ == kControlFrames) {
      const float g = static_cast<float>(to_);
      control();
      return g;
    }
    return static_cast<float>(from_ + (to_ - from_) * (static_cast<double>(pos_) * (1.0 / kControlFrames)));
  }

  /** Current gain reduction (dB, >= 0), before make-up. */
  double reduction_db() const { return -gain_db_; }
  /** Largest gain reduction since the last `restart_peak` (dB, >= 0). */
  double peak_reduction_db() const { return peak_db_; }
  void restart_peak() { peak_db_ = -gain_db_; }

  void reset();

 private:
  double static_curve(double x_db) const;
  /** Start the next ramp, towards the gain the smoother is at now. */
  void control();

  double threshold_ = 0;
  double ratio_ = 1;
  double knee_ = 0;
  double makeup_ = 1;
  double attack_coef_ = 0;
  double release_coef_ = 0;
  double gain_db_ = 0;
  double peak_db_ = 0;
  /** `gain_db_` at the last control update. */
  double control_db_ = 0;
  /** Linear gain (with make-up) at the start and end of the current ramp. */
  double from_ = 1;
  double to_ = 1;
  int pos_ = 0;
};

/**
 * Gate / downward expander: open while the frame peak is at or above the
 * threshold (and for `hold` after), otherwise attenuated by `range` dB. The
 * gain moves in dB with one-pole `attack` (opening) / `release` (closing).
 */
class Gate {
 public:
  bool design(const double* row, double sample_rate, bool keep_state = false);
  float gain(float peak);
  double reduction_db() const { return -gain_db_; }
  double peak_reduction_db() const { return peak_db_; }
  void restart_peak() { peak_db_ = -gain_db_; }
  void reset() {
    gain_db_ = 0.0;
    peak_db_ = 0.0;
    hold_left_ = 0;
  }

 private:
  float threshold_ = 0.f;
  double range_db_ = 0;
  long long hold_frames_ = 0;
  long long hold_left_ = 0;
  double attack_coef_ = 0;
  double release_coef_ = 0;
  double gain_db_ = 0;
  double peak_db_ = 0;
  /** `db_to_gain(cached_db_)`: a closed (or open) gate holds its gain, so the pow is skipped. */
  double cached_db_ = 0;
  float cached_gain_ = 1.f;
};

/**
 * De-esser as a dynamic high shelf. A second-order high-pass at `freq`
 * feeds the detector; when its peak passes the threshold, a high shelf at
 * `freq` cuts by `(over) * (1 - 1 / ratio)` dB, at most `range`, smoothed by
 * `attack` / `release`. At 0 dB the shelf's coefficients are exactly the
 * identity, so a de-esser that never fires passes its input bit for bit.
 * Stereo linked. The detector filter runs per frame; the gain computer and
 * the shelf design run at control rate (`kControlFrames`), and the shelf's
 * coefficients ramp linearly between designs.
 */
class DeEsser {
 public:
  bool design(const double* row, double sample_rate, bool keep_state = false);
  /** Process one frame in place. */
  void process(float* frame, int channels);
  double reduction_db() const { return reduction_db_; }
  double peak_reduction_db() const { return peak_db_; }
  void restart_peak() { peak_db_ = reduction_db_; }
  void reset();

 private:
  /** Design the shelf for `cut_db` into `out` ({b0, b1, b2, a1, a2}). */
  void shelf_for(double cut_db, double* out) const;
  /** One control-rate update from the block that just ended. */
  void control();

  Biquad detect_;
  Biquad shelf_;
  /** Shelf coefficients at the start and end of the current ramp. */
  double from_[5] = {1, 0, 0, 0, 0};
  double to_[5] = {1, 0, 0, 0, 0};
  bool ramping_ = false;
  double block_peak_ = 0;
  int pos_ = 0;
  double peak_db_ = 0;
  double sample_rate_ = 48000;
  double freq_ = 6000;
  double threshold_db_ = 0;
  double slope_ = 0;
  double range_db_ = 0;
  double attack_coef_ = 0;
  double release_coef_ = 0;
  double reduction_db_ = 0;
  /** The cut the shelf's coefficients currently implement. */
  double shelf_db_ = 0;
};

/**
 * Sidechain ducker. The key is "on" for every frame whose peak (another
 * lane's signal) is at or above the threshold, and for `hold` after; the gain
 * then ramps linearly in dB to `-depth` over `attack` and back to 0 dB over
 * `release`, so the duck reaches its depth exactly `attack` after the key
 * starts and recovers exactly `hold + release` after it stops.
 */
class Ducker {
 public:
  bool design(const double* row, double sample_rate, bool keep_state = false);
  /** Gain for this frame given the key frame's peak. */
  float gain(float key_peak);
  double reduction_db() const { return -gain_db_; }
  double peak_reduction_db() const { return peak_db_; }
  void restart_peak() { peak_db_ = -gain_db_; }
  void reset() {
    gain_db_ = 0.0;
    peak_db_ = 0.0;
    hold_left_ = 0;
  }

 private:
  float threshold_ = 0.f;
  double depth_db_ = 0;
  double attack_step_ = 0;
  double release_step_ = 0;
  long long hold_frames_ = 0;
  long long hold_left_ = 0;
  double gain_db_ = 0;
  double peak_db_ = 0;
  /** `db_to_gain(cached_db_)`: a held duck skips the pow. */
  double cached_db_ = 0;
  float cached_gain_ = 1.f;
};

/** A clip's chain: up to `MIX_FX_MAX_EQ_BANDS` biquads, then one compressor. */
class InsertChain {
 public:
  /** Build from `count` packed rows; disabled and unknown blocks are dropped. */
  void build(const double* rows, int count, double sample_rate);

  bool active() const { return band_count_ > 0 || has_compressor_; }

  /** Process one frame in place (`planes` = 1 or 2). */
  void process(float* frame, int planes) {
    for (int b = 0; b < band_count_; ++b) {
      for (int c = 0; c < planes; ++c) frame[c] = bands_[b].process(c, frame[c]);
    }
    if (has_compressor_) {
      float peak = frame[0] < 0 ? -frame[0] : frame[0];
      if (planes > 1) {
        const float r = frame[1] < 0 ? -frame[1] : frame[1];
        if (r > peak) peak = r;
      }
      const float g = compressor_.gain(peak);
      for (int c = 0; c < planes; ++c) frame[c] *= g;
    }
    for (int c = 0; c < planes; ++c) frame[c] = flush_sample(frame[c]);
  }

 private:
  Biquad bands_[4];
  int band_count_ = 0;
  Compressor compressor_;
  bool has_compressor_ = false;
};

/**
 * ITU-R BS.1770-4 Annex 2 true-peak detection: 4x oversampling with the
 * mixer's own polyphase sinc kernel (phases 1/4, 1/2, 3/4 of
 * `sinc_table(sinc_cutoff_for_step(1))` — phase 0 is the sample itself),
 * compiled in as data (`fx/true_peak_taps.inc`), so `init` is O(1). Interpolating between frames needs the 32
 * frames after them, so the detector is a `kDelay`-frame delay line that
 * reports the true peak of the frame it releases.
 */
class TruePeakDetector {
 public:
  static constexpr int kDelay = kSincHalfTaps;

  void init(int channels);
  void reset();

  /** Taps for phase `phase + 1` quarters (0..2): `kSincTaps` floats. */
  static const float* taps(int phase);

  /**
   * Push one frame; writes the frame `kDelay` pushes back to `delayed`
   * (silence while priming) and returns its true peak over `[n, n + 1)`
   * (largest magnitude of any channel and phase).
   */
  float push(const float* frame, float* delayed);

 private:
  int channels_ = 2;
  int pos_ = 0;
  /** Each channel's last `kSincTaps` samples, stored twice so a window is always contiguous. */
  float ring_[2][2 * kSincTaps];
};

/**
 * True-peak look-ahead brickwall limiter. The gain at frame j is the box
 * average, over the `L` frames ending at j, of an instant-attack /
 * exponential-release envelope of the minimum gain any frame in [k, k + L]
 * needs, where a frame's need comes from its true peak
 * (`TruePeakDetector`). Every frame in that average already "saw" frame j
 * coming, so the gain reaches what j needs before j plays. The box keeps the
 * gain smooth enough that the oversampled output stays under the ceiling
 * (the detection ceiling sits `kTruePeakMarginDb` lower to absorb the
 * interpolation of a moving gain), and a final sample clamp makes the
 * sample-peak ceiling a guarantee.
 */
class Limiter {
 public:
  /**
   * Detection headroom below the ceiling (dB). Without it the gain's own
   * movement lets the oversampled output overshoot by up to ~0.005 dB on the
   * host tests' inter-sample battery; 0.05 dB is ten times that.
   */
  static constexpr double kTruePeakMarginDb = 0.05;
  /** Shortest look-ahead (frames): a box shorter than this moves the gain too fast. */
  static constexpr int kMinLookahead = 32;

  /** False when the row is not an enabled limiter. */
  bool design(const double* row, double sample_rate, int channels);

  /** Same look-ahead (so the same latency): ceiling and release may change in place. */
  bool retune(const double* row, double sample_rate);

  /** Frames from input to output: the detector's delay plus the look-ahead. */
  int latency() const { return TruePeakDetector::kDelay + lookahead_; }

  /** `latency()` a limiter designed from `row` would have. */
  static int latency_for(const double* row, double sample_rate) {
    return TruePeakDetector::kDelay + lookahead_for(row, sample_rate);
  }

  void reset();

  /** Push one frame and write the frame `latency()` pushes back (silence while priming). */
  void process(const float* frame, float* out);

  /** Gain applied to the last output frame (1 = untouched). */
  float last_gain() const { return last_gain_; }
  /** Smallest gain applied since the last `restart_peak` (1 = untouched). */
  float min_gain() const { return min_gain_; }
  void restart_peak() { min_gain_ = last_gain_; }

 private:
  static int lookahead_for(const double* row, double sample_rate);

  int channels_ = 2;
  int lookahead_ = 1;
  float ceiling_ = 1.f;
  double detect_ceiling_ = 1.0;
  double release_coef_ = 0;
  long long pushed_ = 0;
  double envelope_ = 1;
  double box_sum_ = 0;
  int box_pos_ = 0;
  float last_gain_ = 1.f;
  float min_gain_ = 1.f;
  TruePeakDetector detector_;
  std::vector<double> box_;
  /** Delay line of `lookahead_ + 1` frames (after the detector's own delay). */
  std::vector<float> delay_;
  /** Monotonic deque (ring) of (frame index, required gain), for the window minimum. */
  std::vector<long long> min_index_;
  std::vector<double> min_value_;
  int min_head_ = 0;
  int min_size_ = 0;
};

/** dB to linear amplitude. */
double db_to_gain(double db);

/** Clamp to [lo, hi]; `fallback` for NaN / inf. */
double clamp_finite(double v, double lo, double hi, double fallback);

/** One-pole smoothing coefficient for time constant `seconds` (0 = instant). */
double time_coef(double seconds, double sample_rate);

}  // namespace media_engine
