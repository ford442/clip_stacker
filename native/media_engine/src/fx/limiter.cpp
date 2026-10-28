// True-peak detection (ITU-R BS.1770-4 Annex 2) and the look-ahead limiter
// built on it. See `TruePeakDetector` / `Limiter` in effects.h.

#include "audio_mix.h"
#include "effects.h"
#include "resampler.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace media_engine {

void TruePeakDetector::init(int channels) {
  channels_ = channels > 1 ? 2 : 1;
  // Copy the three phases out of the shared table: its cache slots are
  // recycled by the mixer, so a pointer into it would not stay valid.
  const float* rows = sinc_table(sinc_cutoff_for_step(1.0));
  for (int k = 1; k <= 3; ++k) sinc_prepare(rows, 0.25 * k, coeff_[k - 1]);
  reset();
}

void TruePeakDetector::reset() {
  pos_ = 0;
  std::memset(ring_, 0, sizeof(ring_));
}

float TruePeakDetector::push(const float* frame, float* delayed) {
  for (int c = 0; c < channels_; ++c) {
    ring_[c][pos_] = frame[c];
    ring_[c][pos_ + kSincTaps] = frame[c];
  }
  pos_ = pos_ + 1 == kSincTaps ? 0 : pos_ + 1;
  float peak = 0.f;
  for (int c = 0; c < channels_; ++c) {
    // window[j] is the sample kSincTaps - 1 - j pushes ago; the frame being
    // released (kDelay pushes ago) is window[kSincHalfTaps - 1], and the taps
    // around it interpolate the three positions between it and the next.
    const float* window = ring_[c] + pos_;
    const float x = window[kSincHalfTaps - 1];
    delayed[c] = x;
    peak = std::max(peak, std::fabs(x));
    for (int k = 0; k < 3; ++k) peak = std::max(peak, std::fabs(sinc_dot(coeff_[k], window)));
  }
  return peak;
}

int Limiter::lookahead_for(const double* row, double sample_rate) {
  const double lookahead = clamp_finite(row[MIX_FX_ATTACK], 0.0, MIX_FX_MAX_LOOKAHEAD_MS / 1000.0, 0.005);
  return std::max(kMinLookahead, static_cast<int>(std::lround(lookahead * sample_rate)));
}

bool Limiter::design(const double* row, double sample_rate, int channels) {
  if (row[MIX_FX_KIND] != MIX_FX_LIMITER || row[MIX_FX_ENABLED] == 0.0) return false;
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  if (channels != 1 && channels != 2) return false;
  channels_ = channels;
  lookahead_ = lookahead_for(row, sample_rate);
  retune(row, sample_rate);
  detector_.init(channels);
  reset();
  return true;
}

bool Limiter::retune(const double* row, double sample_rate) {
  if (lookahead_for(row, sample_rate) != lookahead_) return false;
  const double ceiling_db = clamp_finite(row[MIX_FX_THRESHOLD_DB], -24.0, 0.0, -1.0);
  ceiling_ = static_cast<float>(db_to_gain(ceiling_db));
  detect_ceiling_ = db_to_gain(ceiling_db - kTruePeakMarginDb);
  release_coef_ = time_coef(clamp_finite(row[MIX_FX_RELEASE], 0.001, 5.0, 0.1), sample_rate);
  return true;
}

void Limiter::reset() {
  pushed_ = 0;
  envelope_ = 1.0;
  box_.assign(lookahead_, 1.0);
  box_sum_ = static_cast<double>(lookahead_);
  box_pos_ = 0;
  delay_.assign(static_cast<size_t>(lookahead_ + 1) * channels_, 0.f);
  min_index_.assign(lookahead_ + 1, 0);
  min_value_.assign(lookahead_ + 1, 1.0);
  min_head_ = 0;
  min_size_ = 0;
  last_gain_ = 1.f;
  detector_.reset();
}

void Limiter::process(const float* in, float* out) {
  float frame[2] = {0.f, 0.f};
  const double peak = detector_.push(in, frame);
  const double need = peak > detect_ceiling_ ? detect_ceiling_ / peak : 1.0;

  const int window = lookahead_ + 1;
  const long long m = pushed_++;

  // Sliding minimum of `need` over frames [m - L, m].
  while (min_size_ > 0) {
    const int back = (min_head_ + min_size_ - 1) % window;
    if (min_value_[back] < need) break;
    --min_size_;
  }
  const int slot = (min_head_ + min_size_) % window;
  min_index_[slot] = m;
  min_value_[slot] = need;
  ++min_size_;
  while (min_index_[min_head_] < m - lookahead_) {
    min_head_ = (min_head_ + 1) % window;
    --min_size_;
  }
  const double hold = min_value_[min_head_];

  // Instant attack, exponential release: the envelope never exceeds `hold`.
  envelope_ = hold < envelope_ ? hold : hold + (envelope_ - hold) * release_coef_;

  box_sum_ += envelope_ - box_[box_pos_];
  box_[box_pos_] = envelope_;
  if (++box_pos_ == lookahead_) {
    box_pos_ = 0;
    // Re-sum once per window so the running sum cannot drift over hours.
    double sum = 0.0;
    for (double v : box_) sum += v;
    box_sum_ = sum;
  }

  // Frame m goes to slot m % window; frame m - L sits in (m - L) % window,
  // which is (m + 1) % window for a window of L + 1 slots.
  float* incoming = delay_.data() + static_cast<size_t>(m % window) * channels_;
  for (int c = 0; c < channels_; ++c) incoming[c] = frame[c];
  if (m < lookahead_) {
    for (int c = 0; c < channels_; ++c) out[c] = 0.f;
    return;
  }
  const float* oldest = delay_.data() + static_cast<size_t>((m + 1) % window) * channels_;

  const float gain = static_cast<float>(box_sum_ / lookahead_);
  last_gain_ = gain;
  for (int c = 0; c < channels_; ++c) {
    const float y = oldest[c] * gain;
    out[c] = std::max(-ceiling_, std::min(ceiling_, y));
  }
}

}  // namespace media_engine
