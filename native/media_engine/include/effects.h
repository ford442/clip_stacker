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

#include <vector>

namespace media_engine {

/** Zero for |v| < 1e-30 (see the note above). */
inline double flush_denormal(double v) { return (v > -1e-30 && v < 1e-30) ? 0.0 : v; }

/** One RBJ Audio EQ Cookbook section, transposed direct form II, f64 state. */
class Biquad {
 public:
  /**
   * Design from a packed `MIX_FX_*` row at `sample_rate`. False for a non-EQ
   * kind. `keep_state` retunes without clearing the filter memory.
   */
  bool design(const double* row, double sample_rate, bool keep_state = false);

  /** Raw coefficients (already divided by a0); used by the K-weighting filter. */
  void set(double b0, double b1, double b2, double a1, double a2);

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
 * the louder channel.
 */
class Compressor {
 public:
  bool design(const double* row, double sample_rate, bool keep_state = false);

  /** Gain to apply to the frame whose louder channel has magnitude `peak`. */
  float gain(float peak);

  /** Current gain reduction (dB, >= 0), before make-up. */
  double reduction_db() const { return -gain_db_; }

  void reset() { gain_db_ = 0.0; }

 private:
  double static_curve(double x_db) const;

  double threshold_ = 0;
  double ratio_ = 1;
  double knee_ = 0;
  double makeup_ = 1;
  double attack_coef_ = 0;
  double release_coef_ = 0;
  double gain_db_ = 0;
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
  void reset() {
    gain_db_ = 0.0;
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
};

/**
 * De-esser as a dynamic high shelf. A second-order high-pass at `freq`
 * feeds the detector; when its peak passes the threshold, a high shelf at
 * `freq` cuts by `(over) * (1 - 1 / ratio)` dB, at most `range`, smoothed by
 * `attack` / `release`. At 0 dB the shelf's coefficients are exactly the
 * identity, so a de-esser that never fires passes its input bit for bit.
 * Stereo linked.
 */
class DeEsser {
 public:
  bool design(const double* row, double sample_rate, bool keep_state = false);
  /** Process one frame in place. */
  void process(float* frame, int channels);
  double reduction_db() const { return reduction_db_; }
  void reset() {
    detect_.reset();
    shelf_.reset();
    reduction_db_ = 0.0;
    retune_shelf(0.0);
  }

 private:
  void retune_shelf(double cut_db);

  Biquad detect_;
  Biquad shelf_;
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
  void reset() {
    gain_db_ = 0.0;
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
  }

 private:
  Biquad bands_[4];
  int band_count_ = 0;
  Compressor compressor_;
  bool has_compressor_ = false;
};

/**
 * ITU-R BS.1770-4 Annex 2 true-peak detection: 4x oversampling with the
 * mixer's own polyphase sinc kernel (`sinc_table`, phases 1/4, 1/2, 3/4 —
 * phase 0 is the sample itself). Interpolating between frames needs the 32
 * frames after them, so the detector is a `kDelay`-frame delay line that
 * reports the true peak of the frame it releases.
 */
class TruePeakDetector {
 public:
  static constexpr int kDelay = kSincHalfTaps;

  void init(int channels);
  void reset();

  /**
   * Push one frame; writes the frame `kDelay` pushes back to `delayed`
   * (silence while priming) and returns its true peak over `[n, n + 1)`
   * (largest magnitude of any channel and phase).
   */
  float push(const float* frame, float* delayed);

 private:
  int channels_ = 2;
  int pos_ = 0;
  // No alignas: `sinc_dot` loads through memcpy, and these live inside
  // heap-allocated chains where over-aligned storage buys nothing.
  float coeff_[3][kSincTaps];
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
