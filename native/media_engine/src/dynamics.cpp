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
  if (!keep_state) {
    reset();
  } else {
    // New make-up (or nothing changed): ramp there over the current block.
    to_ = db_to_gain(gain_db_) * makeup_;
  }
  return true;
}

void Compressor::reset() {
  gain_db_ = 0.0;
  peak_db_ = 0.0;
  control_db_ = 0.0;
  from_ = to_ = makeup_;
  pos_ = 0;
}

void Compressor::control() {
  // Ramp to where the smoother will be one block from now (its last block's
  // step, continued), so the ramp is centred on the per-frame gain instead of
  // trailing it by a block. Never past 0 dB of reduction.
  const double ahead = std::min(0.0, gain_db_ + (gain_db_ - control_db_));
  control_db_ = gain_db_;
  from_ = to_;
  to_ = ahead == 0.0 ? makeup_ : db_to_gain(ahead) * makeup_;
  pos_ = 0;
}

double Compressor::static_curve(double x_db) const {
  const double over = x_db - threshold_;
  // Hard knee: the quadratic below would be 0 / 0 at the threshold itself.
  if (!(knee_ > 0.0)) return over > 0.0 ? threshold_ + over / ratio_ : x_db;
  if (2.0 * over < -knee_) return x_db;
  if (2.0 * over > knee_) return threshold_ + over / ratio_;
  // Quadratic knee, centred on the threshold.
  const double k = over + knee_ * 0.5;
  return x_db + (1.0 / ratio_ - 1.0) * k * k / (2.0 * knee_);
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
  if (-gain_db_ > peak_db_) peak_db_ = -gain_db_;
  if (gain_db_ == 0.0) return 1.f;
  if (gain_db_ != cached_db_) {
    cached_db_ = gain_db_;
    cached_gain_ = static_cast<float>(db_to_gain(gain_db_));
  }
  return cached_gain_;
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
  // One control step covers kControlFrames frames of the one-pole smoother.
  attack_coef_ = std::pow(time_coef(clamp_finite(row[MIX_FX_ATTACK], 0.0, 0.1, 0.001), sample_rate), kControlFrames);
  release_coef_ = std::pow(time_coef(clamp_finite(row[MIX_FX_RELEASE], 0.0, 1.0, 0.05), sample_rate), kControlFrames);
  if (!keep_state) {
    reset();
    return true;
  }
  // A retune (new frequency or range): restart the ramp from where the shelf
  // is now to the design for the clamped cut.
  reduction_db_ = std::min(reduction_db_, range_db_);
  shelf_.coefficients(from_);
  shelf_db_ = -reduction_db_;
  shelf_for(shelf_db_, to_);
  ramping_ = true;
  return true;
}

void DeEsser::reset() {
  detect_.reset();
  shelf_.reset();
  reduction_db_ = 0.0;
  peak_db_ = 0.0;
  block_peak_ = 0.0;
  pos_ = 0;
  shelf_db_ = 0.0;
  shelf_for(0.0, to_);
  for (int i = 0; i < 5; ++i) from_[i] = to_[i];
  shelf_.assign(to_);
  ramping_ = false;
}

void DeEsser::shelf_for(double cut_db, double* out) const {
  double shelf[MIX_FX_STRIDE] = {};
  shelf[MIX_FX_KIND] = MIX_FX_HIGH_SHELF;
  shelf[MIX_FX_ENABLED] = 1;
  shelf[MIX_FX_FREQ] = freq_;
  shelf[MIX_FX_GAIN_DB] = cut_db;
  shelf[MIX_FX_Q] = 0.7071067811865476;
  Biquad design;
  design.design(shelf, sample_rate_);
  design.coefficients(out);
}

void DeEsser::control() {
  double target = 0.0;
  if (block_peak_ > 1e-6) {
    const double over = 20.0 * std::log10(block_peak_) - threshold_db_;
    if (over > 0.0) target = std::min(range_db_, over * slope_);
  }
  const double coef = target > reduction_db_ ? attack_coef_ : release_coef_;
  reduction_db_ = target + flush_denormal((reduction_db_ - target) * coef);
  peak_db_ = std::max(peak_db_, reduction_db_);
  block_peak_ = 0.0;
  pos_ = 0;
  // The next ramp starts on the design the last one ended on. Redesign when
  // the cut moves audibly, and always on the way back to 0 dB, where the
  // shelf is the exact identity again.
  for (int i = 0; i < 5; ++i) from_[i] = to_[i];
  const double cut = -reduction_db_;
  if (cut != shelf_db_ && (cut == 0.0 || std::fabs(cut - shelf_db_) > 1e-3)) {
    shelf_for(cut, to_);
    shelf_db_ = cut;
  }
  ramping_ = false;
  for (int i = 0; i < 5; ++i) ramping_ = ramping_ || from_[i] != to_[i];
}

void DeEsser::process(float* frame, int channels) {
  double peak = 0.0;
  for (int c = 0; c < channels; ++c) peak = std::max(peak, std::fabs(detect_.process_d(c, frame[c])));
  if (peak > block_peak_) block_peak_ = peak;
  if (ramping_) {
    double c[5];
    if (pos_ + 1 == kControlFrames) {
      for (int i = 0; i < 5; ++i) c[i] = to_[i];
    } else {
      const double t = static_cast<double>(pos_ + 1) * (1.0 / kControlFrames);
      for (int i = 0; i < 5; ++i) c[i] = from_[i] + (to_[i] - from_[i]) * t;
    }
    shelf_.assign(c);
  }
  for (int c = 0; c < channels; ++c) frame[c] = shelf_.process(c, frame[c]);
  if (++pos_ == kControlFrames) control();
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
  if (-gain_db_ > peak_db_) peak_db_ = -gain_db_;
  if (gain_db_ == 0.0) return 1.f;
  if (gain_db_ != cached_db_) {
    cached_db_ = gain_db_;
    cached_gain_ = static_cast<float>(db_to_gain(gain_db_));
  }
  return cached_gain_;
}

}  // namespace media_engine
