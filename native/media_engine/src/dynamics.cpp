#include "audio_mix.h"
#include "effects.h"

#include <algorithm>
#include <cmath>

namespace media_engine {

double clamp_finite(double v, double lo, double hi, double fallback) {
  if (!std::isfinite(v)) return fallback;
  return std::max(lo, std::min(hi, v));
}

double time_coef(double seconds, double sample_rate) {
  return seconds > 0.0 ? std::exp(-1.0 / (seconds * sample_rate)) : 0.0;
}

double db_to_gain(double db) { return std::pow(10.0, db / 20.0); }

namespace {

long long seconds_to_frames(double seconds, double sample_rate) {
  return static_cast<long long>(std::llround(seconds * sample_rate));
}

}  // namespace

bool Compressor::design(const double* row, double sample_rate, bool keep_state) {
  if (row[MIX_FX_KIND] != MIX_FX_COMPRESSOR) return false;
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  threshold_ = clamp_finite(row[MIX_FX_THRESHOLD_DB], -60.0, 0.0, -20.0);
  ratio_ = clamp_finite(row[MIX_FX_RATIO], 1.0, 20.0, 4.0);
  knee_ = clamp_finite(row[MIX_FX_KNEE_DB], 0.0, 24.0, 6.0);
  makeup_ = db_to_gain(clamp_finite(row[MIX_FX_GAIN_DB], 0.0, 24.0, 0.0));
  attack_coef_ = time_coef(clamp_finite(row[MIX_FX_ATTACK], 0.0, 1.0, 0.01), sample_rate);
  release_coef_ = time_coef(clamp_finite(row[MIX_FX_RELEASE], 0.0, 5.0, 0.1), sample_rate);
  if (!keep_state) gain_db_ = 0.0;
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
  gain_db_ = flush_denormal(coef * gain_db_ + (1.0 - coef) * target);
  return static_cast<float>(db_to_gain(gain_db_) * makeup_);
}

bool Gate::design(const double* row, double sample_rate, bool keep_state) {
  if (row[MIX_FX_KIND] != MIX_FX_GATE) return false;
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  threshold_ = static_cast<float>(db_to_gain(clamp_finite(row[MIX_FX_THRESHOLD_DB], -100.0, 0.0, -50.0)));
  range_db_ = clamp_finite(row[MIX_FX_RANGE_DB], 0.0, 100.0, 40.0);
  attack_coef_ = time_coef(clamp_finite(row[MIX_FX_ATTACK], 0.0, 1.0, 0.001), sample_rate);
  hold_frames_ = seconds_to_frames(clamp_finite(row[MIX_FX_HOLD], 0.0, 5.0, 0.05), sample_rate);
  release_coef_ = time_coef(clamp_finite(row[MIX_FX_RELEASE], 0.0, 5.0, 0.1), sample_rate);
  if (!keep_state) {
    gain_db_ = 0.0;
    hold_left_ = 0;
  }
  return true;
}

float Gate::gain(float peak) {
  bool open = false;
  if (peak >= threshold_) {
    open = true;
    hold_left_ = hold_frames_;
  } else if (hold_left_ > 0) {
    open = true;
    --hold_left_;
  }
  const double target = open ? 0.0 : -range_db_;
  const double coef = target > gain_db_ ? attack_coef_ : release_coef_;
  gain_db_ = target + flush_denormal((gain_db_ - target) * coef);
  return gain_db_ == 0.0 ? 1.f : static_cast<float>(db_to_gain(gain_db_));
}

bool DeEsser::design(const double* row, double sample_rate, bool keep_state) {
  if (row[MIX_FX_KIND] != MIX_FX_DEESSER) return false;
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  sample_rate_ = sample_rate;
  freq_ = clamp_finite(row[MIX_FX_FREQ], 1000.0, 16000.0, 6000.0);
  double split[MIX_FX_STRIDE] = {};
  split[MIX_FX_KIND] = MIX_FX_HIGH_PASS;
  split[MIX_FX_ENABLED] = 1;
  split[MIX_FX_FREQ] = freq_;
  split[MIX_FX_Q] = 0.7071067811865476;
  detect_.design(split, sample_rate, keep_state);
  threshold_db_ = clamp_finite(row[MIX_FX_THRESHOLD_DB], -60.0, 0.0, -30.0);
  slope_ = 1.0 - 1.0 / clamp_finite(row[MIX_FX_RATIO], 1.0, 20.0, 4.0);
  range_db_ = clamp_finite(row[MIX_FX_RANGE_DB], 0.0, 24.0, 6.0);
  attack_coef_ = time_coef(clamp_finite(row[MIX_FX_ATTACK], 0.0, 0.1, 0.001), sample_rate);
  release_coef_ = time_coef(clamp_finite(row[MIX_FX_RELEASE], 0.0, 1.0, 0.05), sample_rate);
  if (!keep_state) {
    shelf_.reset();
    reduction_db_ = 0.0;
  }
  reduction_db_ = std::min(reduction_db_, range_db_);
  retune_shelf(-reduction_db_);
  return true;
}

void DeEsser::retune_shelf(double cut_db) {
  double shelf[MIX_FX_STRIDE] = {};
  shelf[MIX_FX_KIND] = MIX_FX_HIGH_SHELF;
  shelf[MIX_FX_ENABLED] = 1;
  shelf[MIX_FX_FREQ] = freq_;
  shelf[MIX_FX_GAIN_DB] = cut_db;
  shelf[MIX_FX_Q] = 0.7071067811865476;
  shelf_.design(shelf, sample_rate_, true);
  shelf_db_ = cut_db;
}

void DeEsser::process(float* frame, int channels) {
  double peak = 0.0;
  for (int c = 0; c < channels; ++c) peak = std::max(peak, std::fabs(detect_.process_d(c, frame[c])));
  double target = 0.0;
  if (peak > 1e-6) {
    const double over = 20.0 * std::log10(peak) - threshold_db_;
    if (over > 0.0) target = std::min(range_db_, over * slope_);
  }
  const double coef = target > reduction_db_ ? attack_coef_ : release_coef_;
  reduction_db_ = target + flush_denormal((reduction_db_ - target) * coef);
  // Retune when the cut moves audibly, and always on the way back to 0 dB,
  // where the shelf becomes the exact identity again.
  const double cut = -reduction_db_;
  if (cut != shelf_db_ && (cut == 0.0 || std::fabs(cut - shelf_db_) > 1e-3)) retune_shelf(cut);
  for (int c = 0; c < channels; ++c) frame[c] = shelf_.process(c, frame[c]);
}

bool Ducker::design(const double* row, double sample_rate, bool keep_state) {
  if (row[MIX_FX_KIND] != MIX_FX_DUCKER) return false;
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  threshold_ = static_cast<float>(db_to_gain(clamp_finite(row[MIX_FX_THRESHOLD_DB], -80.0, 0.0, -40.0)));
  depth_db_ = clamp_finite(row[MIX_FX_RANGE_DB], 0.0, 60.0, 12.0);
  const double attack_frames = std::max(1.0, clamp_finite(row[MIX_FX_ATTACK], 0.0, 5.0, 0.05) * sample_rate);
  const double release_frames = std::max(1.0, clamp_finite(row[MIX_FX_RELEASE], 0.0, 10.0, 0.5) * sample_rate);
  attack_step_ = depth_db_ / attack_frames;
  release_step_ = depth_db_ / release_frames;
  hold_frames_ = seconds_to_frames(clamp_finite(row[MIX_FX_HOLD], 0.0, 5.0, 0.2), sample_rate);
  if (!keep_state) {
    gain_db_ = 0.0;
    hold_left_ = 0;
  } else {
    gain_db_ = std::max(-depth_db_, gain_db_);
  }
  return true;
}

float Ducker::gain(float key_peak) {
  bool active = false;
  if (key_peak >= threshold_) {
    active = true;
    hold_left_ = hold_frames_;
  } else if (hold_left_ > 0) {
    active = true;
    --hold_left_;
  }
  // Linear ramps in dB, clamped onto the target: the duck lands on its depth
  // (and back on 0 dB) exactly, with no exponential tail.
  if (active) {
    gain_db_ = std::max(-depth_db_, gain_db_ - attack_step_);
  } else if (gain_db_ < 0.0) {
    gain_db_ = std::min(0.0, gain_db_ + release_step_);
  }
  return gain_db_ == 0.0 ? 1.f : static_cast<float>(db_to_gain(gain_db_));
}

}  // namespace media_engine
