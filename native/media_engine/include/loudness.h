#pragma once

// ITU-R BS.1770-4 loudness meter with the EBU Tech 3341 ("EBU Mode") windows
// and EBU Tech 3342 loudness range. Internal C++ API behind
// `loudness_meter_*` and the bus graph's output meter.
//
// The measurement runs on a 100 ms grid ("sub-blocks"): momentary is the
// last 4 sub-blocks (400 ms), short-term the last 30 (3 s), and each
// completed sub-block closes a 400 ms gating block (75 % overlap) and a 3 s
// short-term block for the range. Every boundary is an absolute frame count,
// so the readings do not depend on how the audio was chunked.

#include "effects.h"

namespace media_engine {

/**
 * Gating-block energies binned at 0.1 LU from -70 LUFS (the absolute gate)
 * to +5 LUFS, as libebur128 does: integrated loudness and loudness range are
 * read from it in O(bins), and it never grows. Each bin keeps the exact
 * energy sum of its blocks, so a bin's mean is exact when its blocks are
 * (a steady tone) and within the bin width otherwise; only the bin a gate
 * falls in, and the bins a percentile lands in, are approximated.
 */
class LoudnessHistogram {
 public:
  static constexpr double kMinLufs = -70.0;
  static constexpr double kMaxLufs = 5.0;
  static constexpr int kBinsPerLu = 10;
  static constexpr int kBins = static_cast<int>((kMaxLufs - kMinLufs) * kBinsPerLu);

  void clear();
  /** Add one block's mean-square energy (callers gate it at -70 LUFS first). */
  void add(double energy);
  /** Mean energy of the blocks above `gate` (0 when none). */
  double gated_mean(double gate) const;
  /** EBU Tech 3342 range (LU) of the blocks at or above `gate`; 0 when none. */
  double range(double gate) const;

 private:
  /** First bin whose blocks are (on average) on the passing side of `gate`. */
  int first_bin(double gate, bool inclusive) const;
  double energy_[kBins];
  long long count_[kBins];
};

class LoudnessMeter {
 public:
  /** Sub-blocks in the short-term window (3 s / 100 ms). */
  static constexpr int kShortSubBlocks = 30;
  static constexpr int kMomentarySubBlocks = 4;

  /** False on an unsupported rate / channel count. */
  bool init(double sample_rate, int channels);

  int channels() const { return channels_; }

  /** Forget everything measured so far (filters, windows, history, peaks). */
  void reset();

  /** One interleaved frame. Never allocates. */
  void push(const float* frame);

  /**
   * Close one 100 ms sub-block whose K-weighted squared samples (summed over
   * channels) add up to `sum`. `push` calls it every `hop` frames; tests use
   * it to drive hours of programme without filtering every sample.
   */
  void push_sub_block(double sum);

  /** Frames per 100 ms sub-block at the meter's rate. */
  int hop() const { return hop_; }

  /** LUFS; -inf before the first 100 ms or for digital silence. */
  double momentary() const;
  double short_term() const;
  /** Gated programme loudness (LUFS); -inf until a block passes both gates. O(1) in programme length. */
  double integrated() const;
  /** EBU Tech 3342 loudness range (LU); 0 until it has short-term values. O(1) in programme length. */
  double range() const;
  /** Highest 4x-oversampled peak so far (dBTP). Lags the input by `TruePeakDetector::kDelay` frames. */
  double true_peak_db() const;
  double sample_peak_db() const;

 private:
  double window_energy(int sub_blocks) const;

  int channels_ = 2;
  int hop_ = 4800;
  Biquad pre_;
  Biquad rlb_;
  TruePeakDetector true_peak_;
  int hop_pos_ = 0;
  double hop_sum_ = 0;
  double sub_[kShortSubBlocks] = {};
  int sub_pos_ = 0;
  long long sub_total_ = 0;
  /** 400 ms gating blocks above the absolute gate, and their exact running mean. */
  LoudnessHistogram blocks_;
  double block_gated_sum_ = 0;
  long long block_gated_count_ = 0;
  /** Short-term (3 s) energies at or above the absolute gate, for the range. */
  LoudnessHistogram short_;
  double short_gated_sum_ = 0;
  long long short_gated_count_ = 0;
  float true_peak_max_ = 0.f;
  float sample_peak_max_ = 0.f;
};

}  // namespace media_engine
