#pragma once

// Insert effects for the media-engine mix: RBJ-cookbook biquads, a
// feed-forward soft-knee compressor, and a look-ahead bus limiter. Internal
// C++ API; the packed rows they are built from are documented in audio_mix.h.

#include <vector>

namespace media_engine {

/** One RBJ Audio EQ Cookbook section, transposed direct form II, f64 state. */
class Biquad {
 public:
  /** Design from a packed `MIX_FX_*` row at `sample_rate`. False for a non-EQ kind. */
  bool design(const double* row, double sample_rate);

  float process(int channel, float x) {
    double& z1 = z1_[channel];
    double& z2 = z2_[channel];
    const double y = b0_ * x + z1;
    z1 = b1_ * x - a1_ * y + z2;
    z2 = b2_ * x - a2_ * y;
    // Flush denormals: WASM has no FTZ mode, and a decaying tail in silence
    // would otherwise crawl through subnormal arithmetic.
    if (z1 > -1e-30 && z1 < 1e-30) z1 = 0.0;
    if (z2 > -1e-30 && z2 < 1e-30) z2 = 0.0;
    return static_cast<float>(y);
  }

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
  bool design(const double* row, double sample_rate);

  /** Gain to apply to the frame whose louder channel has magnitude `peak`. */
  float gain(float peak);

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
 * Look-ahead brickwall limiter. The gain at frame j is the box average, over
 * the `L` frames ending at j, of an instant-attack / exponential-release
 * envelope of the minimum gain any frame in [k, k + L] needs. Every frame in
 * that average already "saw" frame j coming, so the gain reaches what j
 * needs before j plays: no overshoot, no hard clip in normal operation. A
 * final clamp makes the ceiling a guarantee rather than a near-miss.
 */
class Limiter {
 public:
  /** False when the row is not an enabled limiter. */
  bool design(const double* row, double sample_rate, int channels);

  int latency() const { return lookahead_; }

  /**
   * Push one bus frame. Once `latency()` frames are buffered, writes the
   * delayed, limited frame to `out` and returns true.
   */
  bool push(const float* frame, float* out);

 private:
  int channels_ = 2;
  int lookahead_ = 1;
  float ceiling_ = 1.f;
  double release_coef_ = 0;
  long long pushed_ = 0;
  double envelope_ = 1;
  double box_sum_ = 0;
  int box_pos_ = 0;
  std::vector<double> box_;
  /** Delay line of `lookahead_ + 1` frames. */
  std::vector<float> delay_;
  /** Monotonic deque (ring) of (frame index, required gain), for the window minimum. */
  std::vector<long long> min_index_;
  std::vector<double> min_value_;
  int min_head_ = 0;
  int min_size_ = 0;
};

}  // namespace media_engine
