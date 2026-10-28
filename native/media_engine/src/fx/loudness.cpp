// ITU-R BS.1770-4 loudness: see loudness.h.

#include "loudness.h"

#include "cs_alloc.h"
#include "cs_math.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace media_engine {

namespace {

constexpr double kOffset = -0.691;
/**
 * Mean-square energy of a block at the -70 LUFS absolute gate,
 * 10^((-70 + 0.691) / 10). A literal: no static initializer, which the
 * standalone (no-entry) WASM build would have to run by hand.
 */
constexpr double kAbsoluteGateEnergy = 1.1724653045822981e-07;
constexpr double kNegInf = -std::numeric_limits<double>::infinity();
/**
 * Below this (about -130 LUFS) a window holds only the K-filters' decaying
 * tail after the programme stopped: report silence, not "-560 LUFS".
 */
constexpr double kSilenceEnergy = 1e-13;

double energy_to_lufs(double z) { return z > kSilenceEnergy ? kOffset + 10.0 * std::log10(z) : kNegInf; }

double peak_db(float peak) { return peak > 0.f ? 20.0 * std::log10(static_cast<double>(peak)) : kNegInf; }

}  // namespace

bool LoudnessMeter::init(double sample_rate, int channels) {
  if (!(sample_rate >= 8000.0) || !std::isfinite(sample_rate)) return false;
  if (channels != 1 && channels != 2) return false;
  channels_ = channels;
  hop_ = static_cast<int>(std::lround(sample_rate / 10.0));

  // K-weighting at any rate from the analogue prototypes behind the 48 kHz
  // table in BS.1770-4 (the bilinear forms reproduce it to the last digit).
  // Stage 1: high shelf, +4 dB above ~1.7 kHz (head acoustics).
  {
    const double f0 = 1681.974450955533;
    const double gain_db = 3.999843853973347;
    const double q = 0.7071752369554196;
    const double k = std::tan(cs::kPi * f0 / sample_rate);
    const double vh = std::pow(10.0, gain_db / 20.0);
    const double vb = std::pow(vh, 0.4996667741545416);
    const double a0 = 1.0 + k / q + k * k;
    pre_.set((vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0,
             2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0);
  }
  // Stage 2: the RLB high-pass (numerator 1, -2, 1 as tabulated).
  {
    const double f0 = 38.13547087602444;
    const double q = 0.5003270373238773;
    const double k = std::tan(cs::kPi * f0 / sample_rate);
    const double a0 = 1.0 + k / q + k * k;
    rlb_.set(1.0, -2.0, 1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0);
  }
  true_peak_.init(channels);
  reset();
  return true;
}

void LoudnessMeter::reset() {
  pre_.reset();
  rlb_.reset();
  true_peak_.reset();
  hop_pos_ = 0;
  hop_sum_ = 0.0;
  std::fill(std::begin(sub_), std::end(sub_), 0.0);
  sub_pos_ = 0;
  sub_total_ = 0;
  blocks_.clear();
  short_.clear();
  short_sorted_ = 0;
  short_gated_sum_ = 0.0;
  short_gated_count_ = 0;
  true_peak_max_ = 0.f;
  sample_peak_max_ = 0.f;
  full_ = false;
}

double LoudnessMeter::window_energy(int sub_blocks) const {
  // The ring starts zeroed, so a window reaching back before the first
  // sub-block reads silence there.
  double sum = 0.0;
  for (int i = 1; i <= sub_blocks; ++i) sum += sub_[(sub_pos_ - i + kShortSubBlocks) % kShortSubBlocks];
  return sum / (static_cast<double>(sub_blocks) * hop_);
}

bool LoudnessMeter::push(const float* frame) {
  float delayed[2];
  true_peak_max_ = std::max(true_peak_max_, true_peak_.push(frame, delayed));
  for (int c = 0; c < channels_; ++c) {
    sample_peak_max_ = std::max(sample_peak_max_, std::fabs(frame[c]));
    const double y = rlb_.process_d(c, pre_.process_d(c, frame[c]));
    hop_sum_ += y * y;
  }
  if (++hop_pos_ < hop_) return !full_;

  sub_[sub_pos_] = hop_sum_;
  sub_pos_ = (sub_pos_ + 1) % kShortSubBlocks;
  ++sub_total_;
  hop_sum_ = 0.0;
  hop_pos_ = 0;
  if (full_) return false;
  if (sub_total_ >= kMomentarySubBlocks && !cs::try_push_back(blocks_, window_energy(kMomentarySubBlocks))) {
    full_ = true;
    return false;
  }
  if (sub_total_ >= kShortSubBlocks) {
    const double z = window_energy(kShortSubBlocks);
    if (!cs::try_push_back(short_, z)) {
      full_ = true;
      return false;
    }
    if (z >= kAbsoluteGateEnergy) {
      short_gated_sum_ += z;
      ++short_gated_count_;
    }
  }
  return true;
}

double LoudnessMeter::momentary() const {
  return sub_total_ > 0 ? energy_to_lufs(window_energy(kMomentarySubBlocks)) : kNegInf;
}

double LoudnessMeter::short_term() const {
  return sub_total_ > 0 ? energy_to_lufs(window_energy(kShortSubBlocks)) : kNegInf;
}

double LoudnessMeter::integrated() const {
  // BS.1770-4: blocks above the absolute gate set a relative gate 10 LU below
  // their mean; the loudness is the mean of the blocks above both.
  double sum = 0.0;
  long long count = 0;
  for (double z : blocks_) {
    if (z > kAbsoluteGateEnergy) {
      sum += z;
      ++count;
    }
  }
  if (count == 0) return kNegInf;
  const double relative = std::max(kAbsoluteGateEnergy, sum / static_cast<double>(count) / 10.0);
  double gated = 0.0;
  long long gated_count = 0;
  for (double z : blocks_) {
    if (z > relative) {
      gated += z;
      ++gated_count;
    }
  }
  return gated_count > 0 ? energy_to_lufs(gated / static_cast<double>(gated_count)) : kNegInf;
}

double LoudnessMeter::range() const {
  if (short_gated_count_ == 0) return 0.0;
  if (short_sorted_ < short_.size()) {
    const auto mid = short_.begin() + static_cast<std::ptrdiff_t>(short_sorted_);
    std::sort(mid, short_.end());
    std::inplace_merge(short_.begin(), mid, short_.end());
    short_sorted_ = short_.size();
  }
  // EBU Tech 3342: absolute gate -70 LUFS, relative gate 20 LU below the
  // absolute-gated mean, then the 10th to 95th percentile (MATLAB rounding).
  const double mean = short_gated_sum_ / static_cast<double>(short_gated_count_);
  const double gate = std::max(kAbsoluteGateEnergy, mean / 100.0);
  const auto first = std::lower_bound(short_.begin(), short_.end(), gate);
  const long long n = short_.end() - first;
  if (n <= 0) return 0.0;
  const long long low = std::llround(static_cast<double>(n - 1) * 0.10);
  const long long high = std::llround(static_cast<double>(n - 1) * 0.95);
  return 10.0 * std::log10(first[high] / first[low]);
}

double LoudnessMeter::true_peak_db() const { return peak_db(true_peak_max_); }

double LoudnessMeter::sample_peak_db() const { return peak_db(sample_peak_max_); }

}  // namespace media_engine
