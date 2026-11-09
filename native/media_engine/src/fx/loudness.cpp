// ITU-R BS.1770-4 loudness: see loudness.h.

#include "loudness.h"

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

// ---------------------------------------------------------------------------
// LoudnessHistogram

namespace {

/** Bin of a block's energy; blocks louder than +5 LUFS share the top bin. */
int bin_of(double energy) {
  const double lufs = kOffset + 10.0 * std::log10(energy);
  const double pos = std::floor((lufs - LoudnessHistogram::kMinLufs) * LoudnessHistogram::kBinsPerLu);
  if (!(pos >= 0.0)) return 0;
  return pos >= LoudnessHistogram::kBins ? LoudnessHistogram::kBins - 1 : static_cast<int>(pos);
}

}  // namespace

void LoudnessHistogram::clear() {
  std::fill(std::begin(energy_), std::end(energy_), 0.0);
  std::fill(std::begin(count_), std::end(count_), 0LL);
}

void LoudnessHistogram::add(double energy) {
  const int b = bin_of(energy);
  energy_[b] += energy;
  ++count_[b];
}

int LoudnessHistogram::first_bin(double gate, bool inclusive) const {
  // Bins above the gate's own bin pass whole and bins below it fail whole;
  // the gate's bin passes when its mean does.
  const int b = bin_of(gate);
  if (count_[b] == 0) return b + 1;
  const double mean = energy_[b] / static_cast<double>(count_[b]);
  return (inclusive ? mean >= gate : mean > gate) ? b : b + 1;
}

double LoudnessHistogram::gated_mean(double gate) const {
  double sum = 0.0;
  long long count = 0;
  for (int b = first_bin(gate, false); b < kBins; ++b) {
    sum += energy_[b];
    count += count_[b];
  }
  return count > 0 ? sum / static_cast<double>(count) : 0.0;
}

double LoudnessHistogram::range(double gate) const {
  const int first = first_bin(gate, true);
  long long n = 0;
  for (int b = first; b < kBins; ++b) n += count_[b];
  if (n <= 0) return 0.0;
  // The 10th and 95th percentiles of the sorted values (MATLAB rounding),
  // each read as the mean of the bin that holds it.
  const long long low = std::llround(static_cast<double>(n - 1) * 0.10);
  const long long high = std::llround(static_cast<double>(n - 1) * 0.95);
  double low_energy = 0.0;
  double high_energy = 0.0;
  long long seen = 0;
  for (int b = first; b < kBins; ++b) {
    if (count_[b] == 0) continue;
    const long long next = seen + count_[b];
    const double mean = energy_[b] / static_cast<double>(count_[b]);
    if (low >= seen && low < next) low_energy = mean;
    if (high >= seen && high < next) {
      high_energy = mean;
      break;
    }
    seen = next;
  }
  return low_energy > 0.0 && high_energy > 0.0 ? 10.0 * std::log10(high_energy / low_energy) : 0.0;
}

// ---------------------------------------------------------------------------
// LoudnessMeter

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
  block_gated_sum_ = 0.0;
  block_gated_count_ = 0;
  short_.clear();
  short_gated_sum_ = 0.0;
  short_gated_count_ = 0;
  true_peak_max_ = 0.f;
  sample_peak_max_ = 0.f;
}

double LoudnessMeter::window_energy(int sub_blocks) const {
  // The ring starts zeroed, so a window reaching back before the first
  // sub-block reads silence there.
  double sum = 0.0;
  for (int i = 1; i <= sub_blocks; ++i) sum += sub_[(sub_pos_ - i + kShortSubBlocks) % kShortSubBlocks];
  return sum / (static_cast<double>(sub_blocks) * hop_);
}

void LoudnessMeter::push(const float* in) {
  // A non-finite sample measures as silence: one inf would otherwise make
  // the K-filter state, the histogram sums and both peaks inf (and the
  // readings NaN) for the rest of the measurement.
  float frame[2] = {0.f, 0.f};
  for (int c = 0; c < channels_; ++c) frame[c] = std::isfinite(in[c]) ? in[c] : 0.f;
  float delayed[2];
  true_peak_max_ = std::max(true_peak_max_, true_peak_.push(frame, delayed));
  for (int c = 0; c < channels_; ++c) {
    sample_peak_max_ = std::max(sample_peak_max_, std::fabs(frame[c]));
    const double y = rlb_.process_d(c, pre_.process_d(c, frame[c]));
    hop_sum_ += y * y;
  }
  if (++hop_pos_ < hop_) return;
  push_sub_block(hop_sum_);
  hop_sum_ = 0.0;
  hop_pos_ = 0;
}

void LoudnessMeter::push_sub_block(double sum) {
  sub_[sub_pos_] = sum;
  sub_pos_ = (sub_pos_ + 1) % kShortSubBlocks;
  ++sub_total_;
  if (sub_total_ >= kMomentarySubBlocks) {
    const double z = window_energy(kMomentarySubBlocks);
    if (z > kAbsoluteGateEnergy) {
      blocks_.add(z);
      block_gated_sum_ += z;
      ++block_gated_count_;
    }
  }
  if (sub_total_ >= kShortSubBlocks) {
    const double z = window_energy(kShortSubBlocks);
    if (z >= kAbsoluteGateEnergy) {
      short_.add(z);
      short_gated_sum_ += z;
      ++short_gated_count_;
    }
  }
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
  if (block_gated_count_ == 0) return kNegInf;
  const double mean = block_gated_sum_ / static_cast<double>(block_gated_count_);
  const double relative = std::max(kAbsoluteGateEnergy, mean / 10.0);
  const double gated = blocks_.gated_mean(relative);
  return gated > 0.0 ? energy_to_lufs(gated) : kNegInf;
}

double LoudnessMeter::range() const {
  // EBU Tech 3342: absolute gate -70 LUFS, relative gate 20 LU below the
  // absolute-gated mean, then the 10th to 95th percentile.
  if (short_gated_count_ == 0) return 0.0;
  const double mean = short_gated_sum_ / static_cast<double>(short_gated_count_);
  return short_.range(std::max(kAbsoluteGateEnergy, mean / 100.0));
}

double LoudnessMeter::true_peak_db() const { return peak_db(true_peak_max_); }

double LoudnessMeter::sample_peak_db() const { return peak_db(sample_peak_max_); }

}  // namespace media_engine
