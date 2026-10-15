#include "audio_mix.h"
#include "effects.h"

#include <algorithm>
#include <cmath>

namespace media_engine {

namespace {

constexpr double kPi = 3.14159265358979323846;

double clamp_finite(double v, double lo, double hi, double fallback) {
  if (!std::isfinite(v)) return fallback;
  return std::max(lo, std::min(hi, v));
}

}  // namespace

bool Biquad::design(const double* row, double sample_rate) {
  const double kind = row[MIX_FX_KIND];
  if (kind != MIX_FX_PEAKING && kind != MIX_FX_LOW_SHELF && kind != MIX_FX_HIGH_SHELF &&
      kind != MIX_FX_HIGH_PASS) {
    return false;
  }
  if (!(sample_rate > 0) || !std::isfinite(sample_rate)) return false;
  // Keep the centre below Nyquist: the cookbook prewarp diverges at fs / 2.
  const double freq = clamp_finite(row[MIX_FX_FREQ], 10.0, 0.49 * sample_rate, 1000.0);
  const double q = clamp_finite(row[MIX_FX_Q], 0.1, 30.0, 0.7071067811865476);
  const double gain_db = clamp_finite(row[MIX_FX_GAIN_DB], -24.0, 24.0, 0.0);

  // Audio EQ Cookbook (R. Bristow-Johnson), Q form for every type.
  const double a = std::pow(10.0, gain_db / 40.0);
  const double w0 = 2.0 * kPi * freq / sample_rate;
  const double cw = std::cos(w0);
  const double alpha = std::sin(w0) / (2.0 * q);
  const double sqrt_a2 = 2.0 * std::sqrt(a) * alpha;

  double b0, b1, b2, a0, a1, a2;
  if (kind == MIX_FX_PEAKING) {
    b0 = 1.0 + alpha * a;
    b1 = -2.0 * cw;
    b2 = 1.0 - alpha * a;
    a0 = 1.0 + alpha / a;
    a1 = -2.0 * cw;
    a2 = 1.0 - alpha / a;
  } else if (kind == MIX_FX_LOW_SHELF) {
    b0 = a * ((a + 1.0) - (a - 1.0) * cw + sqrt_a2);
    b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cw);
    b2 = a * ((a + 1.0) - (a - 1.0) * cw - sqrt_a2);
    a0 = (a + 1.0) + (a - 1.0) * cw + sqrt_a2;
    a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cw);
    a2 = (a + 1.0) + (a - 1.0) * cw - sqrt_a2;
  } else if (kind == MIX_FX_HIGH_SHELF) {
    b0 = a * ((a + 1.0) + (a - 1.0) * cw + sqrt_a2);
    b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cw);
    b2 = a * ((a + 1.0) + (a - 1.0) * cw - sqrt_a2);
    a0 = (a + 1.0) - (a - 1.0) * cw + sqrt_a2;
    a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cw);
    a2 = (a + 1.0) - (a - 1.0) * cw - sqrt_a2;
  } else {
    b0 = (1.0 + cw) * 0.5;
    b1 = -(1.0 + cw);
    b2 = (1.0 + cw) * 0.5;
    a0 = 1.0 + alpha;
    a1 = -2.0 * cw;
    a2 = 1.0 - alpha;
  }
  b0_ = b0 / a0;
  b1_ = b1 / a0;
  b2_ = b2 / a0;
  a1_ = a1 / a0;
  a2_ = a2 / a0;
  z1_[0] = z1_[1] = z2_[0] = z2_[1] = 0.0;
  return true;
}

double Biquad::magnitude_db(double freq, double sample_rate) const {
  const double w = 2.0 * kPi * freq / sample_rate;
  const double c1 = std::cos(w), s1 = std::sin(w);
  const double c2 = std::cos(2 * w), s2 = std::sin(2 * w);
  const double nr = b0_ + b1_ * c1 + b2_ * c2, ni = -(b1_ * s1 + b2_ * s2);
  const double dr = 1.0 + a1_ * c1 + a2_ * c2, di = -(a1_ * s1 + a2_ * s2);
  return 10.0 * std::log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

void InsertChain::build(const double* rows, int count, double sample_rate) {
  band_count_ = 0;
  has_compressor_ = false;
  for (int i = 0; i < count; ++i) {
    const double* row = rows + i * MIX_FX_STRIDE;
    if (row[MIX_FX_ENABLED] == 0.0) continue;
    const double kind = row[MIX_FX_KIND];
    if (kind == MIX_FX_COMPRESSOR) {
      if (!has_compressor_) has_compressor_ = compressor_.design(row, sample_rate);
    } else if (band_count_ < MIX_FX_MAX_EQ_BANDS && bands_[band_count_].design(row, sample_rate)) {
      ++band_count_;
    }
  }
}

}  // namespace media_engine
