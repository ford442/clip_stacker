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

namespace {

/** A tempo curve from 0.5x up to 1.7x and back: every chunk sees a different rate. */
std::vector<double> swept_offsets(int out_frames) {
  const int hops = (out_frames + kHop - 1) / kHop + 1;
  std::vector<double> offs(static_cast<size_t>(hops));
  double pos = 3.25;
  for (int h = 0; h < hops; ++h) {
    offs[static_cast<size_t>(h)] = pos;
    const double t = static_cast<double>(h) / hops;
    pos += kHop * (0.5 + 1.2 * std::sin(kPi * t));
  }
  return offs;
}

struct ChunkRun {
  int status = CS_OK;
  int max_window = 0;
};

/**
 * Drive a session over `offs` in chunks of `chunk_blocks[i % size]` hops,
 * handing each call only the documented window of the source.
 */
ChunkRun remap_chunked(const std::vector<float>& planar, int in_frames, int channels,
                       const std::vector<double>& offs, std::vector<float>& out, int out_frames,
                       const std::vector<int>& chunk_blocks, int tolerance = -1) {
  ChunkRun run;
  void* session = time_stretch_session_create(in_frames, channels, kHop, tolerance);
  CHECK(session != nullptr);
  if (!session) return run;
  const int hop = time_stretch_session_hop(session);
  const int tol = tolerance < 0 ? hop / 2 : tolerance;
  const double margin = 2.0 * hop + tol + 64;
  std::vector<float> window;
  std::vector<float> chunk;
  int done = 0;
  size_t step = 0;
  while (done < out_frames) {
    const int blocks = chunk_blocks[step++ % chunk_blocks.size()];
    const int count = std::min(blocks * hop, out_frames - done);
    const size_t b0 = static_cast<size_t>(done / hop);
    const size_t n_offs = std::min(offs.size() - std::min(offs.size(), b0),
                                   static_cast<size_t>((count + hop - 1) / hop + 1));
    const double* o = offs.data() + std::min(offs.size(), b0);
    double lo = 0.0;
    double hi = 0.0;
    if (n_offs > 0) {
      lo = *std::min_element(o, o + n_offs) - margin;
      hi = *std::max_element(o, o + n_offs) + margin;
    }
    const int first = std::max(0, std::min(in_frames, static_cast<int>(std::floor(lo))));
    const int last = std::max(first, std::min(in_frames, static_cast<int>(std::ceil(hi))));
    const int frames = last - first;
    run.max_window = std::max(run.max_window, frames);
    window.assign(static_cast<size_t>(frames) * channels, 0.f);
    for (int c = 0; c < channels; ++c) {
      std::copy(planar.begin() + static_cast<long>(c) * in_frames + first,
                planar.begin() + static_cast<long>(c) * in_frames + last,
                window.begin() + static_cast<long>(c) * frames);
    }
    chunk.assign(static_cast<size_t>(count) * channels, -1.f);
    run.status = time_stretch_session_process(session, window.data(), frames, first, o,
                                              static_cast<int>(n_offs), chunk.data(), count);
    if (run.status != CS_OK) break;
    for (int c = 0; c < channels; ++c) {
      std::copy(chunk.begin() + static_cast<long>(c) * count, chunk.begin() + static_cast<long>(c + 1) * count,
                out.begin() + static_cast<long>(c) * out_frames + done);
    }
    done += count;
  }
  time_stretch_session_destroy(session);
  return run;
}

}  // namespace

TEST_CASE(chunked_session_equals_the_whole_buffer_bit_for_bit) {
  const int channels = 2;
  const int out_frames = 3 * kRate + 123;  // a ragged final chunk
  const std::vector<double> offs = swept_offsets(out_frames);
  const int in_frames = static_cast<int>(offs.back()) + kRate / 10;
  std::vector<float> planar(static_cast<size_t>(in_frames) * channels);
  const std::vector<float> left = sine(220.0, in_frames, 0.4f);
  const std::vector<float> right = sine(331.0, in_frames, 0.3f, 17.0);
  std::copy(left.begin(), left.end(), planar.begin());
  std::copy(right.begin(), right.end(), planar.begin() + in_frames);

  std::vector<float> whole(static_cast<size_t>(out_frames) * channels, 0.f);
  CHECK(time_stretch_remap(planar.data(), in_frames, channels, offs.data(), static_cast<int>(offs.size()), kHop,
                           -1, whole.data(), out_frames) == CS_OK);
  for (const std::vector<int>& pattern : {std::vector<int>{1}, std::vector<int>{7}, std::vector<int>{3, 1, 20, 2}}) {
    std::vector<float> chunked(whole.size(), 0.f);
    const ChunkRun run = remap_chunked(planar, in_frames, channels, offs, chunked, out_frames, pattern);
    CHECK(run.status == CS_OK);
    size_t mismatches = 0;
    for (size_t i = 0; i < whole.size(); ++i) mismatches += whole[i] != chunked[i] ? 1u : 0u;
    CHECK(mismatches == 0u);
  }
}

TEST_CASE(chunked_session_keeps_the_curve_end_silent) {
  // The curve covers half the output: the chunked tail is silence, as whole.
  const int out_frames = 40 * kHop;
  std::vector<double> offs = constant_offsets(out_frames, 0.75);
  offs.resize(offs.size() / 2);
  const int in_frames = 40 * kHop;
  const std::vector<float> in = sine(440.0, in_frames);
  std::vector<float> whole(static_cast<size_t>(out_frames), 1.f);
  CHECK(time_stretch_remap(in.data(), in_frames, 1, offs.data(), static_cast<int>(offs.size()), kHop, -1,
                           whole.data(), out_frames) == CS_OK);
  std::vector<float> chunked(whole.size(), 1.f);
  CHECK(remap_chunked(in, in_frames, 1, offs, chunked, out_frames, {3}).status == CS_OK);
  CHECK(chunked == whole);
  CHECK(chunked.back() == 0.f);
}

LONG_TEST_CASE(chunk_windows_stay_small_however_long_the_clip) {
  // Ten minutes of mono source at 0.5x: each call sees a few thousand frames.
  const int out_frames = 20 * 60 * 8000;  // 20 min of output at an 8 kHz test rate
  const std::vector<double> offs = constant_offsets(out_frames, 0.5);
  const int in_frames = static_cast<int>(offs.back()) + 1;
  std::vector<float> in(static_cast<size_t>(in_frames));
  for (int i = 0; i < in_frames; ++i) in[static_cast<size_t>(i)] = 0.25f * static_cast<float>(((static_cast<long long>(i) * 7919) % 2000) - 1000) / 1000.f;
  std::vector<float> out(static_cast<size_t>(out_frames), 0.f);
  const ChunkRun run = remap_chunked(in, in_frames, 1, offs, out, out_frames, {94});  // ~48k output frames
  CHECK(run.status == CS_OK);
  CHECK_LE(run.max_window, 94 * kHop / 2 + 2 * (2 * kHop + kHop / 2 + 64) + 2);
}

TEST_CASE(chunked_session_refuses_a_short_window_and_input_after_the_end) {
  const int in_frames = 20 * kHop;
  const std::vector<float> in = sine(440.0, in_frames);
  const std::vector<double> offs = constant_offsets(8 * kHop, 1.25, 4.5 * kHop);
  std::vector<float> out(static_cast<size_t>(4 * kHop), 0.f);

  CHECK(time_stretch_session_create(0, 1, kHop, -1) == nullptr);
  CHECK(time_stretch_session_create(1.5, 1, kHop, -1) == nullptr);
  CHECK(time_stretch_session_create(in_frames, 9, kHop, -1) == nullptr);
  CHECK(time_stretch_session_create(std::numeric_limits<double>::infinity(), 1, kHop, -1) == nullptr);

  void* session = time_stretch_session_create(in_frames, 1, kHop, -1);
  CHECK(session != nullptr);
  // A window that starts too late for the first segment's reads.
  CHECK(time_stretch_session_process(session, in.data() + 6 * kHop, 10 * kHop, 6.0 * kHop, offs.data(), 5,
                                     out.data(), 4 * kHop) == CS_ERANGE);
  // Window past the source, fractional start, missing pointers.
  CHECK(time_stretch_session_process(session, in.data(), in_frames, 1.0, offs.data(), 5, out.data(), 4 * kHop) ==
        CS_EINVAL);
  CHECK(time_stretch_session_process(session, in.data(), 10, 0.5, offs.data(), 5, out.data(), 4 * kHop) ==
        CS_EINVAL);
  CHECK(time_stretch_session_process(session, in.data(), in_frames, 0.0, nullptr, 5, out.data(), 4 * kHop) ==
        CS_EINVAL);
  // The whole source is always enough; a short chunk is final.
  CHECK(time_stretch_session_process(session, in.data(), in_frames, 0.0, offs.data(), 5, out.data(), 4 * kHop) ==
        CS_OK);
  CHECK(time_stretch_session_process(session, in.data(), in_frames, 0.0, offs.data() + 4, 4, out.data(),
                                     3 * kHop + 1) == CS_OK);
  CHECK(time_stretch_session_process(session, in.data(), in_frames, 0.0, offs.data(), 1, out.data(), kHop) ==
        CS_ESTATE);
  time_stretch_session_destroy(session);
  time_stretch_session_destroy(nullptr);
}
