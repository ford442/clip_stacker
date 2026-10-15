// Host tests for the WSOLA time stretch in the media engine. Same source as
// public/wasm/media_engine.wasm, built natively under ASan + UBSan.

#include "cs_status.h"
#include "host_test.h"
#include "time_stretch.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace {

constexpr int kRate = 44100;
constexpr int kHop = 512;
constexpr double kPi = 3.14159265358979323846;

std::vector<float> sine(double hz, int frames, float amp = 0.5f, double phase_frames = 0.0) {
  std::vector<float> out(static_cast<size_t>(frames));
  for (int i = 0; i < frames; ++i) {
    out[static_cast<size_t>(i)] = amp * static_cast<float>(std::sin(2.0 * kPi * hz * (i + phase_frames) / kRate));
  }
  return out;
}

/** One offset per hop, `ceil(out / hop) + 1` of them, at a constant tempo. */
std::vector<double> constant_offsets(int out_frames, double tempo, double origin = 0.0) {
  const int hops = (out_frames + kHop - 1) / kHop + 1;
  std::vector<double> offs(static_cast<size_t>(hops));
  for (int h = 0; h < hops; ++h) offs[static_cast<size_t>(h)] = origin + static_cast<double>(h) * kHop * tempo;
  return offs;
}

int remap(const std::vector<float>& in, int channels, const std::vector<double>& offs, std::vector<float>& out,
          int tolerance = -1) {
  const int in_frames = static_cast<int>(in.size()) / channels;
  const int out_frames = static_cast<int>(out.size()) / channels;
  return time_stretch_remap(in.data(), in_frames, channels, offs.data(), static_cast<int>(offs.size()), kHop,
                            tolerance, out.data(), out_frames);
}

/** Frequency from upward zero crossings over [lo, hi). */
double zero_crossing_hz(const float* x, int lo, int hi) {
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
  for (int i = 0; i < n; ++i) s += static_cast<double>(x[i]) * static_cast<double>(x[i]);
  return std::sqrt(s / std::max(1, n));
}

/**
 * Smallest / largest short-window RMS over [lo, hi). A pure tone stretched
 * with segments added out of phase dips at every crossfade; added in phase
 * it stays flat.
 */
double envelope_flatness(const std::vector<float>& x, int lo, int hi, int window) {
  double lowest = std::numeric_limits<double>::max();
  double highest = 0.0;
  for (int i = lo; i + window <= hi; i += window / 4) {
    const double level = rms(x.data() + i, window);
    lowest = std::min(lowest, level);
    highest = std::max(highest, level);
  }
  return highest > 0.0 ? lowest / highest : 0.0;
}

}  // namespace

TEST_CASE(invalid_args_are_rejected) {
  std::vector<float> in(4096, 0.f), out(4096, 0.f);
  const double offs[2] = {0.0, 512.0};
  CHECK(time_stretch_remap(nullptr, 4096, 1, offs, 2, kHop, -1, out.data(), 4096) == CS_EINVAL);
  CHECK(time_stretch_remap(in.data(), 0, 1, offs, 2, kHop, -1, out.data(), 4096) == CS_EINVAL);
  CHECK(time_stretch_remap(in.data(), 4096, 0, offs, 2, kHop, -1, out.data(), 4096) == CS_EINVAL);
  CHECK(time_stretch_remap(in.data(), 512, 9, offs, 2, kHop, -1, out.data(), 512) == CS_EINVAL);
  CHECK(time_stretch_remap(in.data(), 4096, 1, offs, 0, kHop, -1, out.data(), 4096) == CS_EINVAL);
  CHECK(time_stretch_remap(in.data(), 4096, 1, offs, 2, kHop, -1, nullptr, 4096) == CS_EINVAL);
  const double bad[2] = {0.0, std::nan("")};
  CHECK(time_stretch_remap(in.data(), 4096, 1, bad, 2, kHop, -1, out.data(), 4096) == CS_EINVAL);
}

TEST_CASE(tempo_one_is_bit_exact) {
  const int frames = kRate;
  const std::vector<float> in = sine(440.0, frames);
  std::vector<float> out(static_cast<size_t>(frames), 1.f);
  CHECK(remap(in, 1, constant_offsets(frames, 1.0), out) == CS_OK);
  CHECK(out == in);
}

TEST_CASE(tempo_one_stereo_keeps_channels_apart) {
  const int frames = kRate / 2;
  std::vector<float> in = sine(440.0, frames);
  const std::vector<float> right = sine(1000.0, frames, 0.25f);
  in.insert(in.end(), right.begin(), right.end());
  std::vector<float> out(static_cast<size_t>(frames) * 2, 1.f);
  CHECK(remap(in, 2, constant_offsets(frames, 1.0), out) == CS_OK);
  CHECK(out == in);
}

TEST_CASE(near_integral_offsets_still_copy) {
  // A curve integrated in JS lands a hair off whole frames at rate 1.
  const int frames = kRate / 2;
  const std::vector<float> in = sine(523.25, frames);
  std::vector<double> offs = constant_offsets(frames, 1.0);
  for (size_t h = 0; h < offs.size(); ++h) offs[h] += (h % 2 ? 1e-9 : -1e-9);
  std::vector<float> out(static_cast<size_t>(frames), 1.f);
  CHECK(remap(in, 1, offs, out) == CS_OK);
  CHECK(out == in);
}

TEST_CASE(tempo_two_halves_length_and_keeps_pitch) {
  const int in_frames = kRate * 2;
  const int out_frames = in_frames / 2;
  const std::vector<float> in = sine(440.0, in_frames);
  std::vector<float> out(static_cast<size_t>(out_frames), 0.f);
  CHECK(remap(in, 1, constant_offsets(out_frames, 2.0), out) == CS_OK);

  // Pitch is preserved (a resample would read 880 Hz), and level is kept all
  // the way to the end of the half-length output.
  const double hz = zero_crossing_hz(out.data(), kHop * 2, out_frames - kHop * 2);
  CHECK_NEAR(hz, 440.0, 5.0);
  CHECK_GE(rms(out.data() + kHop * 2, out_frames - kHop * 4), 0.33);
}

TEST_CASE(tempo_half_doubles_length_and_keeps_pitch) {
  const int in_frames = kRate;
  const int out_frames = in_frames * 2;
  const std::vector<float> in = sine(440.0, in_frames);
  std::vector<float> out(static_cast<size_t>(out_frames), 0.f);
  CHECK(remap(in, 1, constant_offsets(out_frames, 0.5), out) == CS_OK);
  const double hz = zero_crossing_hz(out.data(), kHop * 2, out_frames - kHop * 2);
  CHECK_NEAR(hz, 440.0, 5.0);
  CHECK_GE(rms(out.data() + kHop * 2, out_frames - kHop * 4), 0.33);
}

TEST_CASE(similarity_search_removes_crossfade_dips) {
  // 0.5x slows a 440 Hz tone; nominal segment starts are 256 frames apart
  // where the natural continuation is 512, ~2.6 cycles out of phase. Plain
  // OLA (tolerance 0) beats at every crossfade; WSOLA lines the phases up.
  const int in_frames = kRate;
  const int out_frames = in_frames * 2;
  const std::vector<float> in = sine(440.0, in_frames);
  std::vector<float> ola(static_cast<size_t>(out_frames), 0.f);
  std::vector<float> wsola(static_cast<size_t>(out_frames), 0.f);
  const std::vector<double> offs = constant_offsets(out_frames, 0.5);
  CHECK(remap(in, 1, offs, ola, 0) == CS_OK);
  CHECK(remap(in, 1, offs, wsola) == CS_OK);
  const int lo = kHop * 4;
  const int hi = out_frames - kHop * 4;
  const double ola_flat = envelope_flatness(ola, lo, hi, 256);
  const double wsola_flat = envelope_flatness(wsola, lo, hi, 256);
  std::printf("    envelope min/max: OLA %.3f, WSOLA %.3f\n", ola_flat, wsola_flat);
  CHECK_LE(ola_flat, 0.6);
  CHECK_GE(wsola_flat, 0.9);
}

TEST_CASE(positions_past_two_to_the_24_stay_sub_sample) {
  // ~6.3 min at 44.1 kHz: a float position can no longer hold half a frame.
  // Read a half-frame-shifted window of a slow tone there and compare with
  // the tone itself.
  const int origin = (1 << 24) + 1000;
  const int frames = origin + kRate / 4;
  const double hz = 97.0;
  const std::vector<float> in = sine(hz, frames);
  const int out_frames = kRate / 8;
  std::vector<float> out(static_cast<size_t>(out_frames), 0.f);
  CHECK(remap(in, 1, constant_offsets(out_frames, 1.0, origin + 0.5), out) == CS_OK);
  const std::vector<float> want = sine(hz, out_frames, 0.5f, origin + 0.5);
  double max_err = 0.0;
  for (int i = 0; i < out_frames; ++i) {
    max_err = std::max(max_err, std::fabs(static_cast<double>(out[static_cast<size_t>(i)]) -
                                          static_cast<double>(want[static_cast<size_t>(i)])));
  }
  CHECK_LE(max_err, 2e-3);
}

TEST_CASE(output_past_the_last_offset_is_silent) {
  const int frames = kRate / 4;
  const std::vector<float> in = sine(440.0, frames);
  std::vector<float> out(static_cast<size_t>(frames), 1.f);
  const std::vector<double> offs = {0.0, kHop, 2.0 * kHop};
  CHECK(remap(in, 1, offs, out) == CS_OK);
  // Blocks 0 and 1 have both neighbours; block 2 has no segment 2 + 1 and
  // plays segment 2 alone; everything after is silence.
  for (int i = 0; i < 2 * kHop; ++i) CHECK(out[static_cast<size_t>(i)] == in[static_cast<size_t>(i)]);
  bool silent = true;
  for (int i = 3 * kHop; i < frames; ++i) silent = silent && out[static_cast<size_t>(i)] == 0.f;
  CHECK(silent);
}

TEST_CASE(reads_outside_the_input_are_silence) {
  const int frames = 4 * kHop;
  const std::vector<float> in(static_cast<size_t>(frames), 0.25f);
  std::vector<float> out(static_cast<size_t>(frames), 1.f);
  CHECK(remap(in, 1, constant_offsets(frames, 1.0, 1.0e9), out) == CS_OK);
  bool silent = true;
  for (float v : out) silent = silent && v == 0.f;
  CHECK(silent);
}
