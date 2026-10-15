// Host tests for the WSOLA time stretch. Same source as
// public/wasm/time_stretch.wasm, built natively under ASan + UBSan.

#include "time_stretch.h"
#include "host_test.h"

#include <cmath>
#include <vector>

namespace {

constexpr int kRate = 44100;
constexpr int kHop = 512;
constexpr double kPi = 3.14159265358979323846;

std::vector<float> sine(double hz, int frames, float amp = 0.5f) {
  std::vector<float> out(static_cast<size_t>(frames));
  for (int i = 0; i < frames; ++i) {
    out[static_cast<size_t>(i)] = amp * static_cast<float>(std::sin(2.0 * kPi * hz * i / kRate));
  }
  return out;
}

/** Frequency from upward zero crossings over [lo, hi). */
double zeroCrossingHz(const float* x, int lo, int hi) {
  int first = -1;
  int last = -1;
  int count = 0;
  for (int i = lo + 1; i < hi; ++i) {
    if (x[i - 1] < 0.f && x[i] >= 0.f) {
      if (first < 0) first = i;
      last = i;
      ++count;
    }
  }
  if (count < 2) return 0.0;
  return (count - 1) * static_cast<double>(kRate) / (last - first);
}

double rms(const float* x, int n) {
  double s = 0.0;
  for (int i = 0; i < n; ++i) s += static_cast<double>(x[i]) * x[i];
  return std::sqrt(s / std::max(1, n));
}

}  // namespace

TEST_CASE(invalid_args_are_rejected) {
  std::vector<float> in(1024, 0.f), out(1024, 0.f);
  const float offs[2] = {0.f, 512.f};
  CHECK(time_stretch_constant(nullptr, 1024, 1, 1.f, out.data(), 1024, kHop) != 0);
  CHECK(time_stretch_constant(in.data(), 0, 1, 1.f, out.data(), 1024, kHop) != 0);
  CHECK(time_stretch_constant(in.data(), 1024, 0, 1.f, out.data(), 1024, kHop) != 0);
  CHECK(time_stretch_remap(in.data(), 1024, 9, offs, 2, kHop, out.data(), 1024) != 0);
  CHECK(time_stretch_remap(in.data(), 1024, 1, offs, 0, kHop, out.data(), 1024) != 0);
}

TEST_CASE(tempo_one_is_a_near_copy) {
  const int frames = kRate;
  const std::vector<float> in = sine(440.0, frames);
  std::vector<float> out(static_cast<size_t>(frames), 0.f);
  CHECK(time_stretch_constant(in.data(), frames, 1, 1.f, out.data(), frames, kHop) == 0);
  double maxErr = 0.0;
  for (int i = 0; i < frames; ++i) {
    maxErr = std::max(maxErr, std::fabs(static_cast<double>(out[static_cast<size_t>(i)]) -
                                        in[static_cast<size_t>(i)]));
  }
  // Not bit-exact (window normalization in float), but a copy.
  CHECK_LE(maxErr, 1e-4);
}

TEST_CASE(tempo_one_stereo_keeps_channels_apart) {
  const int frames = kRate / 2;
  std::vector<float> in = sine(440.0, frames);
  const std::vector<float> right = sine(1000.0, frames, 0.25f);
  in.insert(in.end(), right.begin(), right.end());
  std::vector<float> out(static_cast<size_t>(frames) * 2, 0.f);
  CHECK(time_stretch_constant(in.data(), frames, 2, 1.f, out.data(), frames, kHop) == 0);
  double maxErr = 0.0;
  for (size_t i = 0; i < out.size(); ++i) {
    maxErr = std::max(maxErr, std::fabs(static_cast<double>(out[i]) - in[i]));
  }
  CHECK_LE(maxErr, 1e-4);
}

TEST_CASE(tempo_two_halves_length_and_keeps_pitch) {
  const int inFrames = kRate * 2;
  const int outFrames = inFrames / 2;
  const std::vector<float> in = sine(440.0, inFrames);
  std::vector<float> out(static_cast<size_t>(outFrames), 0.f);
  CHECK(time_stretch_constant(in.data(), inFrames, 1, 2.f, out.data(), outFrames, kHop) == 0);

  // Pitch is preserved (a resample would read 880 Hz), and level is kept all
  // the way to the end of the half-length output.
  const double hz = zeroCrossingHz(out.data(), kHop * 2, outFrames - kHop * 2);
  CHECK_NEAR(hz, 440.0, 15.0);
  CHECK_GE(rms(out.data() + kHop * 2, outFrames - kHop * 4), 0.2);
}

TEST_CASE(remap_identity_matches_constant_tempo_one) {
  const int frames = kRate;
  const std::vector<float> in = sine(330.0, frames);
  std::vector<float> a(static_cast<size_t>(frames), 0.f), b(static_cast<size_t>(frames), 0.f);
  CHECK(time_stretch_constant(in.data(), frames, 1, 1.f, a.data(), frames, kHop) == 0);

  const int numHops = (frames + kHop - 1) / kHop + 1;
  std::vector<float> offs(static_cast<size_t>(numHops));
  for (int h = 0; h < numHops; ++h) offs[static_cast<size_t>(h)] = static_cast<float>(h * kHop);
  CHECK(time_stretch_remap(in.data(), frames, 1, offs.data(), numHops, kHop, b.data(), frames) == 0);

  double maxErr = 0.0;
  for (int i = 0; i < frames; ++i) {
    maxErr = std::max(maxErr, std::fabs(static_cast<double>(a[static_cast<size_t>(i)]) -
                                        b[static_cast<size_t>(i)]));
  }
  CHECK_LE(maxErr, 1e-6);
}
