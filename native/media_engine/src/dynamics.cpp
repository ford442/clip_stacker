#include "audio_mix.h"
#include "effects.h"

#include <algorithm>
#include <cmath>

namespace media_engine {

namespace {

double clamp_finite(double v, double lo, double hi, double fallback) {
  if (!std::isfinite(v)) return fallback;
  return std::max(lo, std::min(hi, v));
}

/** One-pole smoothing coefficient for time constant `seconds`. */
double time_coef(double seconds, double sample_rate) {
  return seconds > 0.0 ? std::exp(-1.0 / (seconds * sample_rate)) : 0.0;
}

}  // namespace

bool Compressor::design(const double* row, double sample_rate) {
  if (row[MIX_FX_KIND] != MIX_FX_COMPRESSOR) return false;
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  threshold_ = clamp_finite(row[MIX_FX_THRESHOLD_DB], -60.0, 0.0, -20.0);
  ratio_ = clamp_finite(row[MIX_FX_RATIO], 1.0, 20.0, 4.0);
  knee_ = clamp_finite(row[MIX_FX_KNEE_DB], 0.0, 24.0, 6.0);
  makeup_ = std::pow(10.0, clamp_finite(row[MIX_FX_GAIN_DB], 0.0, 24.0, 0.0) / 20.0);
  attack_coef_ = time_coef(clamp_finite(row[MIX_FX_ATTACK], 0.0, 1.0, 0.01), sample_rate);
  release_coef_ = time_coef(clamp_finite(row[MIX_FX_RELEASE], 0.0, 5.0, 0.1), sample_rate);
  gain_db_ = 0.0;
  return true;
}

double Compressor::static_curve(double x_db) const {
  const double over = x_db - threshold_;
  if (2.0 * over < -knee_) return x_db;
  if (2.0 * over > knee_) return threshold_ + over / ratio_;
  // Quadratic knee, centred on the threshold.
  const double k = over + knee_ * 0.5;
  return x_db + (1.0 / ratio_ - 1.0) * k * k / (2.0 * knee_);
}

float Compressor::gain(float peak) {
  const double x_db = peak > 1e-6f ? 20.0 * std::log10(static_cast<double>(peak)) : -120.0;
  const double target = static_curve(x_db) - x_db;  // <= 0
  const double coef = target < gain_db_ ? attack_coef_ : release_coef_;
  gain_db_ = coef * gain_db_ + (1.0 - coef) * target;
  return static_cast<float>(std::pow(10.0, gain_db_ / 20.0) * makeup_);
}

bool Limiter::design(const double* row, double sample_rate, int channels) {
  if (row[MIX_FX_KIND] != MIX_FX_LIMITER || row[MIX_FX_ENABLED] == 0.0) return false;
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  if (channels != 1 && channels != 2) return false;
  channels_ = channels;
  const double ceiling_db = clamp_finite(row[MIX_FX_THRESHOLD_DB], -24.0, 0.0, -1.0);
  ceiling_ = static_cast<float>(std::pow(10.0, ceiling_db / 20.0));
  const double lookahead =
      clamp_finite(row[MIX_FX_ATTACK], 0.0, MIX_FX_MAX_LOOKAHEAD_MS / 1000.0, 0.005);
  lookahead_ = std::max(1, static_cast<int>(std::lround(lookahead * sample_rate)));
  release_coef_ = time_coef(clamp_finite(row[MIX_FX_RELEASE], 0.001, 5.0, 0.1), sample_rate);

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
  return true;
}

bool Limiter::push(const float* frame, float* out) {
  const int window = lookahead_ + 1;
  const long long m = pushed_++;

  float peak = 0.f;
  for (int c = 0; c < channels_; ++c) peak = std::max(peak, std::fabs(frame[c]));
  const double need = peak > ceiling_ ? static_cast<double>(ceiling_) / peak : 1.0;

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
  if (m < lookahead_) return false;
  const float* oldest = delay_.data() + static_cast<size_t>((m + 1) % window) * channels_;

  const float gain = static_cast<float>(box_sum_ / lookahead_);
  for (int c = 0; c < channels_; ++c) {
    const float y = oldest[c] * gain;
    out[c] = std::max(-ceiling_, std::min(ceiling_, y));
  }
  return true;
}

}  // namespace media_engine
