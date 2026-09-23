// Host (non-Emscripten) tests for the media-engine DSP. Same sources as the
// WASM module, built natively so numeric regressions fail in ctest instead of
// only through the JS glue tests.
//
//   scripts/test-native.sh               # configure + build + ctest
//   media_engine_tests --list            # case names
//   media_engine_tests resample decim    # run cases whose name contains a filter

#include "audio_mix.h"
#include "resampler.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// Tiny assert runner (no Catch2 / GoogleTest dependency).

struct TestCase {
  const char* name;
  void (*fn)();
};

std::vector<TestCase>& registry() {
  static std::vector<TestCase> cases;
  return cases;
}

struct Registrar {
  Registrar(const char* name, void (*fn)()) { registry().push_back({name, fn}); }
};

int g_failures = 0;

void report(bool ok, const char* expr, const char* file, int line) {
  if (ok) return;
  ++g_failures;
  std::fprintf(stderr, "    %s:%d: CHECK(%s) failed\n", file, line, expr);
}

void report_cmp(bool ok, double a, double b, const char* expr, const char* file, int line) {
  if (ok) return;
  ++g_failures;
  std::fprintf(stderr, "    %s:%d: CHECK(%s) failed (%.9g vs %.9g)\n", file, line, expr, a, b);
}

#define TEST_CASE(name)                                   \
  void name();                                            \
  const Registrar registrar_##name(#name, name);          \
  void name()

#define CHECK(cond) report((cond), #cond, __FILE__, __LINE__)
#define CHECK_LE(a, b) report_cmp((a) <= (b), (a), (b), #a " <= " #b, __FILE__, __LINE__)
#define CHECK_GE(a, b) report_cmp((a) >= (b), (a), (b), #a " >= " #b, __FILE__, __LINE__)
#define CHECK_NEAR(a, b, tol) \
  report_cmp(std::fabs((a) - (b)) <= (tol), (a), (b), #a " ~= " #b, __FILE__, __LINE__)

// ---------------------------------------------------------------------------
// Fixtures: schedule model + packing that mirrors src/wasm/mediaEngine.ts.

constexpr int kOutRate = 48000;
constexpr double kPi = 3.14159265358979323846;

struct Key {
  double t;
  double value;
  int easing = MIX_EASING_LINEAR;
  double x1 = 0, y1 = 0, x2 = 1, y2 = 1;
};

struct Clip {
  int sample_rate;
  std::vector<std::vector<float>> planes;  // 1 (mono) or 2 (stereo) planar channels
  int frames() const { return static_cast<int>(planes[0].size()); }
};

struct Entry {
  int clip = 0;
  double timeline_start = 0;
  double duration = 0;
  double buffer_offset = 0;
  double volume = 1;
  double fade_in = 0;
  double fade_out = 0;
  double playback_rate = 1;
  std::vector<Key> volume_keys;
  std::vector<Key> pan_keys;
};

struct Schedule {
  std::vector<Clip> clips;
  std::vector<Entry> entries;
};

Clip make_clip(int rate, double seconds, int channels, float (*gen)(int ch, double t)) {
  Clip clip{rate, {}};
  const int n = static_cast<int>(std::lround(seconds * rate));
  clip.planes.assign(channels, std::vector<float>(n));
  for (int c = 0; c < channels; ++c) {
    for (int i = 0; i < n; ++i) clip.planes[c][i] = gen(c, static_cast<double>(i) / rate);
  }
  return clip;
}

/**
 * Source frames a chunk reads for one entry, plus the resampler margin —
 * the same window `sliceWindow` in src/wasm/mediaEngine.ts uploads.
 */
std::pair<int, int> chunk_window(const Entry& e, const Clip& clip, long long begin, long long end) {
  const double sr = kOutRate;
  const double first_of = std::max(static_cast<double>(begin), std::floor(e.timeline_start * sr));
  const double end_of =
      std::min(static_cast<double>(end), std::ceil((e.timeline_start + e.duration) * sr) + 1.0);
  if (!(first_of < end_of)) return {0, 0};
  const double rate = e.playback_rate > 0 ? e.playback_rate : 1.0;
  const double offset = std::max(0.0, e.buffer_offset);
  auto pos = [&](double of) { return (offset + (of / sr - e.timeline_start) * rate) * clip.sample_rate; };
  const double lo = std::floor(pos(first_of)) - MIX_SOURCE_MARGIN_FRAMES;
  const double hi = std::floor(pos(end_of - 1)) + MIX_SOURCE_MARGIN_FRAMES + 1;
  const int first = static_cast<int>(std::max(0.0, lo));
  const int last = static_cast<int>(std::min(static_cast<double>(clip.frames()), hi));
  return first < last ? std::make_pair(first, last) : std::make_pair(0, 0);
}

void append_keys(std::vector<double>& blob, const std::vector<Key>& keys) {
  for (const Key& k : keys) {
    blob.insert(blob.end(), {k.t, k.value, static_cast<double>(k.easing), k.x1, k.y1, k.x2, k.y2});
  }
}

/** One mix call. `sliced` uploads only the window [begin, end) reads (streaming mode). */
int mix_call(const Schedule& s, float* out, long long begin, int frames, int flags, int out_ch, bool sliced) {
  std::vector<float> pcm;
  std::vector<int> meta;
  std::vector<double> rows;
  std::vector<double> keys;
  for (const Entry& e : s.entries) {
    const Clip& clip = s.clips[e.clip];
    std::pair<int, int> window{0, clip.frames()};
    if (sliced) {
      window = chunk_window(e, clip, begin, begin + frames);
      if (window.first == window.second) continue;
    }
    const double slice_index = static_cast<double>(meta.size() / MIX_SLICE_STRIDE);
    const int len = window.second - window.first;
    meta.insert(meta.end(), {static_cast<int>(pcm.size()), len, static_cast<int>(clip.planes.size()),
                             clip.sample_rate, window.first, clip.frames()});
    for (const auto& plane : clip.planes) {
      pcm.insert(pcm.end(), plane.begin() + window.first, plane.begin() + window.second);
    }
    const double vol_first = static_cast<double>(keys.size() / MIX_KEY_STRIDE);
    append_keys(keys, e.volume_keys);
    const double pan_first = static_cast<double>(keys.size() / MIX_KEY_STRIDE);
    append_keys(keys, e.pan_keys);
    rows.insert(rows.end(), {slice_index, e.timeline_start, e.duration, e.buffer_offset, e.volume,
                             e.fade_in, e.fade_out, e.playback_rate, vol_first,
                             static_cast<double>(e.volume_keys.size()), pan_first,
                             static_cast<double>(e.pan_keys.size())});
  }
  if (pcm.empty()) pcm.push_back(0.f);
  return mix_timeline_audio_range(
      out, frames, static_cast<int>(begin), kOutRate, out_ch, pcm.data(), meta.data(),
      static_cast<int>(meta.size() / MIX_SLICE_STRIDE), rows.data(),
      static_cast<int>(rows.size() / MIX_ENTRY_STRIDE), keys.data(),
      static_cast<int>(keys.size() / MIX_KEY_STRIDE), flags);
}

std::vector<float> mix_whole(const Schedule& s, int frames, int flags = 0, int out_ch = 2) {
  std::vector<float> out(static_cast<size_t>(frames) * out_ch);
  const int rc = mix_call(s, out.data(), 0, frames, flags, out_ch, false);
  CHECK(rc == 0);
  return out;
}

std::vector<float> mix_chunked(const Schedule& s, int frames, int chunk, int flags = 0) {
  std::vector<float> out(static_cast<size_t>(frames) * 2);
  for (int begin = 0; begin < frames; begin += chunk) {
    const int n = std::min(chunk, frames - begin);
    const int rc = mix_call(s, out.data() + static_cast<size_t>(begin) * 2, begin, n, flags, 2, true);
    CHECK(rc == 0);
  }
  return out;
}

std::vector<double> channel(const std::vector<float>& interleaved, int ch, int first, int count) {
  std::vector<double> x(count);
  for (int i = 0; i < count; ++i) x[i] = interleaved[static_cast<size_t>(first + i) * 2 + ch];
  return x;
}

/**
 * THD+N (dB): remove the fundamental at `freq` (least-squares sin/cos/DC over a
 * window holding whole cycles) and compare residual to fundamental RMS.
 */
double thd_n_db(const std::vector<double>& x, int first_frame, double freq) {
  const size_t n = x.size();
  const double w = 2.0 * kPi * freq / kOutRate;
  double s = 0, c = 0, dc = 0;
  for (size_t i = 0; i < n; ++i) {
    const double ph = w * static_cast<double>(first_frame + static_cast<long long>(i));
    s += x[i] * std::sin(ph);
    c += x[i] * std::cos(ph);
    dc += x[i];
  }
  s *= 2.0 / n;
  c *= 2.0 / n;
  dc /= n;
  double residual = 0;
  for (size_t i = 0; i < n; ++i) {
    const double ph = w * static_cast<double>(first_frame + static_cast<long long>(i));
    const double r = x[i] - s * std::sin(ph) - c * std::cos(ph) - dc;
    residual += r * r;
  }
  const double fundamental_rms = std::sqrt(0.5 * (s * s + c * c));
  return 20.0 * std::log10(std::sqrt(residual / n) / fundamental_rms);
}

double rms_db(const std::vector<double>& x, double reference_rms) {
  double sum = 0;
  for (double v : x) sum += v * v;
  return 20.0 * std::log10(std::sqrt(sum / x.size()) / reference_rms);
}

// Reference `sampleKeyframes` / `applyEasing` (src/utils/keyframes.ts), written
// as the straight segment scan the TS uses — independent of the C++ cursor.
double ref_bezier(double u, double x1, double y1, double x2, double y2) {
  const double target = std::max(0.0, std::min(1.0, u));
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  double t = target;
  for (int i = 0; i < 8; ++i) {
    const double x = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t - target;
    const double dx = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (std::fabs(dx) < 1e-6) break;
    t = std::max(0.0, std::min(1.0, t - x / dx));
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
}

double ref_ease(double u, const Key& k) {
  const double c = std::max(0.0, std::min(1.0, u));
  switch (k.easing) {
    case MIX_EASING_LINEAR:
      return c;
    case MIX_EASING_BELL_SMOOTH:
      return std::sin(c * kPi);
    case MIX_EASING_BELL_SHARP: {
      const double fold = c < 0.5 ? 2 * c : 2 * (1 - c);
      return fold == 0 ? 0 : std::pow(2.0, 10 * fold - 10);
    }
    default:
      return ref_bezier(c, k.x1, k.y1, k.x2, k.y2);
  }
}

double ref_sample(const std::vector<Key>& keys, double t, double fallback) {
  if (keys.empty()) return fallback;
  if (keys.size() == 1 || t <= keys[0].t) return keys[0].value;
  for (size_t i = 0; i + 1 < keys.size(); ++i) {
    const Key& a = keys[i];
    const Key& b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const double span = b.t - a.t;
      if (span <= 0) return b.value;
      return a.value + (b.value - a.value) * ref_ease((t - a.t) / span, a);
    }
  }
  const Key& a = keys[keys.size() - 2];
  const Key& b = keys.back();
  return a.value + (b.value - a.value) * ref_ease(1.0, a);
}

float sine_gen_1k(int, double t) { return static_cast<float>(0.5 * std::sin(2 * kPi * 1000.0 * t)); }
float sine_gen_5k(int, double t) { return static_cast<float>(0.5 * std::sin(2 * kPi * 5000.0 * t)); }
float sine_gen_10k(int, double t) { return static_cast<float>(0.5 * std::sin(2 * kPi * 10000.0 * t)); }
float sine_gen_18k(int, double t) { return static_cast<float>(0.5 * std::sin(2 * kPi * 18000.0 * t)); }

float program_gen(int ch, double t) {
  // Multi-tone "program" material with different content per channel.
  const double base = ch == 0 ? 220.0 : 330.0;
  return static_cast<float>(0.3 * std::sin(2 * kPi * base * t) + 0.2 * std::sin(2 * kPi * 3100.0 * t + ch) +
                            0.1 * std::sin(2 * kPi * 9700.0 * t));
}

uint32_t g_lcg = 12345;
float noise_gen(int, double) {
  g_lcg = g_lcg * 1664525u + 1013904223u;
  return static_cast<float>((g_lcg >> 8) & 0xffff) / 32768.f - 1.f;
}

// ---------------------------------------------------------------------------
// Goldens: THD+N of a 0.5-amplitude sine resampled 44.1 kHz -> 48 kHz, measured
// on the left channel over 1 s of steady state. Sinc must stay at or below its
// golden (+1 dB slack for libm differences); linear is the phase-1 baseline.

struct ThdGolden {
  double freq;
  float (*gen)(int, double);
  double sinc_max_db;
  double linear_min_db;
};

const ThdGolden kThdGoldens[] = {
    {1000.0, sine_gen_1k, -114.0, -62.5},
    {5000.0, sine_gen_5k, -115.5, -34.0},
    {10000.0, sine_gen_10k, -111.5, -20.5},
};

TEST_CASE(resample_thd_44k1_to_48k) {
  for (const ThdGolden& g : kThdGoldens) {
    Schedule s;
    s.clips.push_back(make_clip(44100, 2.5, 2, g.gen));
    Entry e;
    e.duration = 2.0;
    s.entries.push_back(e);
    const int frames = 2 * kOutRate;
    const auto sinc = mix_whole(s, frames);
    const auto linear = mix_whole(s, frames, MIX_FLAG_LINEAR_RESAMPLE);
    const int first = kOutRate / 2;
    const double sinc_db = thd_n_db(channel(sinc, 0, first, kOutRate), first, g.freq);
    const double linear_db = thd_n_db(channel(linear, 0, first, kOutRate), first, g.freq);
    std::printf("    %5.0f Hz  THD+N sinc %7.1f dB  linear %6.1f dB\n", g.freq, sinc_db, linear_db);
    CHECK_LE(sinc_db, g.sinc_max_db + 1.0);
    CHECK_GE(linear_db, g.linear_min_db - 1.0);
    CHECK_LE(sinc_db, linear_db - 40.0);
  }
}

TEST_CASE(decimating_step_rejects_aliases) {
  // Playback rate 2 on 48 kHz audio: an 18 kHz tone would land at 36 kHz,
  // above the output Nyquist, so an ideal resampler outputs silence.
  Schedule s;
  s.clips.push_back(make_clip(48000, 5.0, 2, sine_gen_18k));
  Entry e;
  e.duration = 2.0;
  e.playback_rate = 2.0;
  s.entries.push_back(e);
  const int frames = 2 * kOutRate;
  const double input_rms = 0.5 / std::sqrt(2.0);
  const int first = kOutRate / 2;
  const double sinc_db = rms_db(channel(mix_whole(s, frames), 0, first, kOutRate), input_rms);
  const double linear_db =
      rms_db(channel(mix_whole(s, frames, MIX_FLAG_LINEAR_RESAMPLE), 0, first, kOutRate), input_rms);
  std::printf("    18 kHz @2x alias  sinc %7.1f dB  linear %6.1f dB\n", sinc_db, linear_db);
  CHECK_LE(sinc_db, -90.0);
  CHECK_GE(linear_db, -3.0);
}

TEST_CASE(same_rate_copy_is_bit_exact) {
  g_lcg = 99;
  Schedule s;
  s.clips.push_back(make_clip(48000, 2.0, 2, noise_gen));
  Entry e;
  e.timeline_start = 0.5;
  e.duration = 1.0;
  e.buffer_offset = 0.25;
  e.volume = 0.5;
  s.entries.push_back(e);
  const int frames = 2 * kOutRate;
  const auto out = mix_whole(s, frames);
  bool exact = true;
  for (int of = 0; of < frames; ++of) {
    const int src = of - 24000 + 12000;
    const bool active = of >= 24000 && of < 72000;
    for (int c = 0; c < 2; ++c) {
      const float want = active ? s.clips[0].planes[c][src] * 0.5f : 0.f;
      if (out[static_cast<size_t>(of) * 2 + c] != want) exact = false;
    }
  }
  CHECK(exact);
}

Schedule automation_schedule() {
  g_lcg = 7;
  Schedule s;
  s.clips.push_back(make_clip(44100, 3.0, 2, program_gen));  // resampled, stereo
  s.clips.push_back(make_clip(48000, 3.0, 1, noise_gen));    // same-rate copy, mono
  s.clips.push_back(make_clip(32000, 4.0, 2, program_gen));  // decimating + stretched

  Entry a;
  a.clip = 0;
  a.timeline_start = 0.1003;
  a.duration = 2.4;
  a.buffer_offset = 0.2;
  a.playback_rate = 1.25;
  a.fade_in = 0.3;
  a.fade_out = 0.4;
  a.volume_keys = {{0.0, 0.2}, {0.8, 1.6, MIX_EASING_BEZIER, 0.42, 0, 0.58, 1}, {1.6, 0.4}};
  a.pan_keys = {{0.0, -1.0}, {2.4, 1.0}};

  Entry b;
  b.clip = 1;
  b.timeline_start = 1.0;
  b.duration = 1.5;
  b.volume = 0.7;
  b.pan_keys = {{0.2, 0.6, MIX_EASING_BELL_SMOOTH}, {1.2, -0.6}};

  Entry c;
  c.clip = 2;
  c.timeline_start = 0.75;
  c.duration = 2.0;
  c.buffer_offset = 0.5;
  c.playback_rate = 0.8;
  c.volume = 0.9;
  c.volume_keys = {{0.5, 1.0, MIX_EASING_BELL_SHARP}, {1.5, 0.1}};

  s.entries = {a, b, c};
  return s;
}

TEST_CASE(chunked_mix_matches_whole_mix_bitwise) {
  const Schedule s = automation_schedule();
  const int frames = 3 * kOutRate;
  for (int flags : {0, static_cast<int>(MIX_FLAG_LINEAR_RESAMPLE)}) {
    const auto whole = mix_whole(s, frames, flags);
    for (int chunk : {1024, 777, 3 * 4096 + 5}) {
      const auto chunked = mix_chunked(s, frames, chunk, flags);
      CHECK(std::memcmp(whole.data(), chunked.data(), whole.size() * sizeof(float)) == 0);
    }
  }
}

float dc_gen(int ch, double) { return ch == 0 ? 0.8f : 0.4f; }
float one_gen(int, double) { return 1.f; }

TEST_CASE(volume_curve_matches_sample_keyframes) {
  Schedule s;
  s.clips.push_back(make_clip(48000, 3.0, 2, one_gen));
  Entry e;
  e.duration = 2.5;
  e.volume = 0.3;  // ignored when a curve exists (keyframes are absolute gain)
  e.fade_in = 0.25;
  e.fade_out = 0.5;
  e.volume_keys = {
      {0.1, 0.2},
      {0.5, 1.9, MIX_EASING_BEZIER, 0.3, 1.8, 0.7, -0.6},  // overshoots: exercises the 0..2 clamp
      {1.0, 0.5, MIX_EASING_BELL_SMOOTH},
      {1.4, 1.0, MIX_EASING_BELL_SHARP},
      {1.6, 0.3},
      {1.6, 1.2},  // duplicate time: zero-length segment
      {2.2, 0.8},
  };
  s.entries.push_back(e);
  const int frames = static_cast<int>(2.6 * kOutRate);
  const auto out = mix_whole(s, frames);
  double worst = 0;
  for (int of = 0; of < frames; ++of) {
    const double local = static_cast<double>(of) / kOutRate;
    double want = 0;
    if (local < e.duration) {
      want = ref_sample(e.volume_keys, local, e.volume);
      if (local < e.fade_in) want *= local / e.fade_in;
      if (local > e.duration - e.fade_out) {
        want *= std::max(0.0, std::min(1.0, (e.duration - local) / e.fade_out));
      }
      want = std::max(0.0, std::min(2.0, want));
    }
    worst = std::max(worst, std::fabs(out[static_cast<size_t>(of) * 2] - want));
    worst = std::max(worst, std::fabs(out[static_cast<size_t>(of) * 2 + 1] - want));
  }
  CHECK_LE(worst, 1e-6);
}

TEST_CASE(pan_matches_stereo_panner_law) {
  Schedule s;
  s.clips.push_back(make_clip(48000, 2.0, 2, dc_gen));
  s.clips.push_back(make_clip(48000, 2.0, 1, one_gen));
  Entry stereo;
  stereo.duration = 1.0;
  stereo.pan_keys = {{0.0, -1.0}, {1.0, 1.0}};
  Entry mono;
  mono.clip = 1;
  mono.timeline_start = 1.0;
  mono.duration = 1.0;
  s.entries = {stereo, mono};
  const auto out = mix_whole(s, 2 * kOutRate);

  double worst = 0;
  for (int of = 0; of < kOutRate; ++of) {
    const double pan = -1.0 + 2.0 * (static_cast<double>(of) / kOutRate);
    const double x = pan <= 0 ? pan + 1 : pan;
    const double gl = std::cos(x * kPi / 2);
    const double gr = std::sin(x * kPi / 2);
    const double in_l = 0.8f;
    const double in_r = 0.4f;
    const double want_l = pan == 0 ? in_l : pan < 0 ? in_l + in_r * gl : in_l * gl;
    const double want_r = pan == 0 ? in_r : pan < 0 ? in_r * gr : in_r + in_l * gr;
    worst = std::max(worst, std::fabs(out[static_cast<size_t>(of) * 2] - want_l));
    worst = std::max(worst, std::fabs(out[static_cast<size_t>(of) * 2 + 1] - want_r));
  }
  CHECK_LE(worst, 1e-6);
  // Mono source at centre pan: equal-power -3 dB on both sides, like StereoPannerNode.
  const size_t mid = static_cast<size_t>(kOutRate + kOutRate / 2) * 2;
  CHECK_NEAR(out[mid], std::sqrt(0.5), 1e-6);
  CHECK_NEAR(out[mid + 1], std::sqrt(0.5), 1e-6);
}

TEST_CASE(linear_flag_keeps_phase1_interpolation) {
  Schedule s;
  s.clips.push_back(make_clip(44100, 1.0, 1, sine_gen_1k));
  Entry e;
  e.duration = 0.5;
  e.playback_rate = 1.1;
  s.entries.push_back(e);
  const int frames = kOutRate / 2;
  const auto out = mix_whole(s, frames, MIX_FLAG_LINEAR_RESAMPLE);
  const std::vector<float>& src = s.clips[0].planes[0];
  double worst = 0;
  for (int of = 0; of < frames; ++of) {
    const double pos = (static_cast<double>(of) / kOutRate) * 1.1 * 44100.0;
    const int i0 = static_cast<int>(pos);
    const int i1 = std::min(i0 + 1, static_cast<int>(src.size()) - 1);
    const float t = static_cast<float>(pos - i0);
    const float v = src[i0] + (src[i1] - src[i0]) * t;
    worst = std::max(worst, std::fabs(out[static_cast<size_t>(of) * 2] - v * std::sqrt(0.5)));
  }
  CHECK_LE(worst, 1e-6);
}

TEST_CASE(reads_outside_clip_are_silent) {
  Schedule s;
  s.clips.push_back(make_clip(44100, 0.5, 2, one_gen));
  Entry e;
  e.duration = 1.0;  // twice the clip: the tail must be silence, not garbage
  e.playback_rate = 1.0;
  s.entries.push_back(e);
  const auto out = mix_whole(s, kOutRate);
  bool tail_silent = true;
  for (int of = kOutRate / 2 + 1; of < kOutRate; ++of) {
    if (out[static_cast<size_t>(of) * 2] != 0.f) tail_silent = false;
  }
  CHECK(tail_silent);
  // Unity DC gain in the steady state (every polyphase row sums to 1).
  CHECK_NEAR(out[static_cast<size_t>(kOutRate / 4) * 2], 1.0, 1e-6);
}

TEST_CASE(mono_output_downmixes) {
  Schedule s;
  s.clips.push_back(make_clip(48000, 1.0, 2, dc_gen));
  Entry e;
  e.duration = 1.0;
  s.entries.push_back(e);
  const auto out = mix_whole(s, 100, 0, 1);
  CHECK_NEAR(out[50], 0.5 * (0.8f + 0.4f), 1e-7);
}

TEST_CASE(rejects_malformed_arguments) {
  float out[8] = {};
  const float pcm[4] = {};
  const int meta[MIX_SLICE_STRIDE] = {0, 4, 1, 48000, 0, 4};
  double row[MIX_ENTRY_STRIDE] = {0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0};
  CHECK(mix_timeline_audio(out, 4, 48000, 3, pcm, meta, 1, row, 1, nullptr, 0, 0) == -1);
  CHECK(mix_timeline_audio_range(out, 4, -1, 48000, 2, pcm, meta, 1, row, 1, nullptr, 0, 0) == -1);
  CHECK(mix_timeline_audio(out, 4, 48000, 2, nullptr, meta, 1, row, 1, nullptr, 0, 0) == -1);
  row[MIX_ENTRY_VOLUME_KEY_COUNT] = 2;  // curve points past the keyframe blob
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, meta, 1, row, 1, nullptr, 0, 0) == -2);
  row[MIX_ENTRY_VOLUME_KEY_COUNT] = 0;
  row[MIX_ENTRY_SLICE_INDEX] = 5;  // unknown slice: skipped, not an error
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, meta, 1, row, 1, nullptr, 0, 0) == 0);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc > 1 && std::strcmp(argv[1], "--list") == 0) {
    for (const TestCase& t : registry()) std::printf("%s\n", t.name);
    return 0;
  }
  int ran = 0;
  int failed_cases = 0;
  for (const TestCase& t : registry()) {
    bool selected = argc <= 1;
    for (int i = 1; i < argc && !selected; ++i) selected = std::strstr(t.name, argv[i]) != nullptr;
    if (!selected) continue;
    ++ran;
    const int before = g_failures;
    std::printf("[ RUN  ] %s\n", t.name);
    t.fn();
    const bool ok = g_failures == before;
    if (!ok) ++failed_cases;
    std::printf("[ %s ] %s\n", ok ? " OK " : "FAIL", t.name);
  }
  std::printf("%d case(s), %d failed\n", ran, failed_cases);
  return ran == 0 || failed_cases > 0 ? 1 : 0;
}
