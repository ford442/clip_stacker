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

#include <vector>

namespace media_engine {

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

  /** One interleaved frame. False once the block history could not grow (readings freeze). */
  bool push(const float* frame);

  /** LUFS; -inf before the first 100 ms or for digital silence. */
  double momentary() const;
  double short_term() const;
  /** Gated programme loudness (LUFS); -inf until a block passes both gates. */
  double integrated() const;
  /** EBU Tech 3342 loudness range (LU); 0 until it has short-term values. */
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
  /** Mean-square energy of every complete 400 ms gating block. */
  std::vector<double> blocks_;
  /**
   * Short-term (3 s) energies for the range percentiles. Appended unsorted
   * and merged into order on read: a live meter merges one value per read,
   * an export sorts once at the end.
   */
  mutable std::vector<double> short_;
  mutable size_t short_sorted_ = 0;
  /** Sum of `short_` energies at or above the -70 LUFS absolute gate. */
  double short_gated_sum_ = 0;
  long long short_gated_count_ = 0;
  float true_peak_max_ = 0.f;
  float sample_peak_max_ = 0.f;
  bool full_ = false;
};

}  // namespace media_engine
