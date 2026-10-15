// Host (non-Emscripten) tests for the media-engine DSP. Same sources as the
// WASM module, built natively so numeric regressions fail in ctest instead of
// only through the JS glue tests.
//
//   scripts/test-native.sh               # configure + build + ctest
//   media_engine_tests --list            # case names
//   media_engine_tests resample decim    # run cases whose name contains a filter

#include "audio_mix.h"
#include "effects.h"
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

/** One packed `MIX_FX_*` row. */
using Fx = std::vector<double>;

Fx eq_block(int kind, double freq, double gain_db, double q) {
  Fx row(MIX_FX_STRIDE, 0.0);
  row[MIX_FX_KIND] = kind;
  row[MIX_FX_ENABLED] = 1;
  row[MIX_FX_FREQ] = freq;
  row[MIX_FX_GAIN_DB] = gain_db;
  row[MIX_FX_Q] = q;
  return row;
}

Fx compressor_block(double threshold_db, double ratio, double attack, double release, double knee_db,
                    double makeup_db = 0) {
  Fx row(MIX_FX_STRIDE, 0.0);
  row[MIX_FX_KIND] = MIX_FX_COMPRESSOR;
  row[MIX_FX_ENABLED] = 1;
  row[MIX_FX_THRESHOLD_DB] = threshold_db;
  row[MIX_FX_RATIO] = ratio;
  row[MIX_FX_ATTACK] = attack;
  row[MIX_FX_RELEASE] = release;
  row[MIX_FX_KNEE_DB] = knee_db;
  row[MIX_FX_GAIN_DB] = makeup_db;
  return row;
}

Fx limiter_block(double ceiling_db, double lookahead = 0.005, double release = 0.1) {
  Fx row(MIX_FX_STRIDE, 0.0);
  row[MIX_FX_KIND] = MIX_FX_LIMITER;
  row[MIX_FX_ENABLED] = 1;
  row[MIX_FX_THRESHOLD_DB] = ceiling_db;
  row[MIX_FX_ATTACK] = lookahead;
  row[MIX_FX_RELEASE] = release;
  return row;
}

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
  std::vector<Fx> fx;
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
      out, frames, static_cast<int>(begin), kOutRate, out_ch, pcm.data(), static_cast<int>(pcm.size()), meta.data(),
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

/**
 * Mix through an fx session, `chunk` frames per call (whole when `chunk >=
 * frames`), the way `TimelineMixStream` drives it: entries are uploaded for
 * the bus range (output range shifted by the limiter look-ahead), and in
 * chunked mode an active entry whose window is empty still gets a zero-length
 * slice so its chain keeps hearing (silent) frames.
 */
std::vector<float> mix_fx(const Schedule& s, int frames, int chunk, const std::vector<Fx>& bus = {},
                          int out_ch = 2, int flags = MIX_FLAG_EFFECTS, int* rc_out = nullptr) {
  std::vector<double> blob;
  std::vector<std::pair<int, int>> ranges;
  for (const Entry& e : s.entries) {
    ranges.emplace_back(static_cast<int>(blob.size() / MIX_FX_STRIDE), static_cast<int>(e.fx.size()));
    for (const Fx& row : e.fx) blob.insert(blob.end(), row.begin(), row.end());
  }
  const int bus_first = static_cast<int>(blob.size() / MIX_FX_STRIDE);
  for (const Fx& row : bus) blob.insert(blob.end(), row.begin(), row.end());
  if (blob.empty()) blob.push_back(0.0);
  MixFxSession* session = mix_fx_session_create(kOutRate, out_ch, static_cast<int>(s.entries.size()), blob.data(),
                                                static_cast<int>(blob.size() / MIX_FX_STRIDE), bus_first,
                                                static_cast<int>(bus.size()));
  CHECK(session != nullptr);
  std::vector<float> out(static_cast<size_t>(frames) * out_ch);
  if (!session) return out;
  const int latency = mix_fx_session_latency(session);
  const bool sliced = chunk < frames;
  const bool fx_rows = (flags & MIX_FLAG_EFFECTS) != 0;
  int rc = 0;
  for (int begin = 0; begin < frames && rc == 0; begin += chunk) {
    const int n = std::min(chunk, frames - begin);
    const long long bus_begin = begin == 0 ? 0 : begin + latency;
    const long long bus_end = static_cast<long long>(begin) + n + latency;
    std::vector<float> pcm;
    std::vector<int> meta;
    std::vector<double> rows;
    std::vector<double> keys;
    for (size_t i = 0; i < s.entries.size(); ++i) {
      const Entry& e = s.entries[i];
      const Clip& clip = s.clips[e.clip];
      std::pair<int, int> window{0, clip.frames()};
      if (sliced) {
        const double first_of = std::floor(e.timeline_start * kOutRate);
        const double end_of = std::ceil((e.timeline_start + e.duration) * kOutRate) + 1.0;
        if (end_of <= static_cast<double>(bus_begin) || first_of >= static_cast<double>(bus_end)) continue;
        window = chunk_window(e, clip, bus_begin, bus_end);
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
      if (fx_rows) {
        rows.insert(rows.end(), {static_cast<double>(ranges[i].first), static_cast<double>(ranges[i].second),
                                 static_cast<double>(i)});
      }
    }
    if (pcm.empty()) pcm.push_back(0.f);
    const int stride = fx_rows ? static_cast<int>(MIX_ENTRY_FX_STRIDE) : static_cast<int>(MIX_ENTRY_STRIDE);
    rc = mix_fx_session_range(session, out.data() + static_cast<size_t>(begin) * out_ch, n, begin, pcm.data(),
                              static_cast<int>(pcm.size()), meta.data(), static_cast<int>(meta.size() / MIX_SLICE_STRIDE), rows.data(),
                              static_cast<int>(rows.size() / stride), keys.data(),
                              static_cast<int>(keys.size() / MIX_KEY_STRIDE), flags);
  }
  if (rc_out) {
    *rc_out = rc;
  } else {
    CHECK(rc == 0);
  }
  mix_fx_session_destroy(session);
  return out;
}

/** Least-squares amplitude of the `freq` component of `x` (frame index `first_frame` onwards). */
double tone_amplitude(const std::vector<double>& x, int first_frame, double freq, double rate = kOutRate) {
  const double w = 2.0 * kPi * freq / rate;
  double s = 0, c = 0;
  for (size_t i = 0; i < x.size(); ++i) {
    const double ph = w * static_cast<double>(first_frame + static_cast<long long>(i));
    s += x[i] * std::sin(ph);
    c += x[i] * std::cos(ph);
  }
  s *= 2.0 / x.size();
  c *= 2.0 / x.size();
  return std::sqrt(s * s + c * c);
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

uint64_t fnv1a(const std::vector<float>& x) {
  uint64_t h = 1469598103934665603ull;
  const auto* bytes = reinterpret_cast<const unsigned char*>(x.data());
  for (size_t i = 0; i < x.size() * sizeof(float); ++i) {
    h ^= bytes[i];
    h *= 1099511628211ull;
  }
  return h;
}

/**
 * Same-rate copy schedule with fades and constant gain: no libm on the path
 * (no sinc table, pan law, or easing), so its bytes are host-independent.
 */
Schedule libm_free_schedule() {
  g_lcg = 4242;
  Schedule s;
  s.clips.push_back(make_clip(48000, 2.0, 2, noise_gen));
  s.clips.push_back(make_clip(48000, 2.0, 2, noise_gen));
  Entry a;
  a.timeline_start = 0.0;
  a.duration = 1.5;
  a.buffer_offset = 0.1;
  a.volume = 0.8;
  a.fade_in = 0.2;
  a.fade_out = 0.3;
  Entry b;
  b.clip = 1;
  b.timeline_start = 1.2;
  b.duration = 0.75;
  b.volume = 1.4;
  b.fade_out = 0.5;
  s.entries = {a, b};
  return s;
}

TEST_CASE(no_effect_mix_matches_pinned_bytes) {
  // Pinned before insert effects existed: a schedule without effect blocks
  // must keep producing these exact bytes, whole or chunked.
  const Schedule s = libm_free_schedule();
  const int frames = 2 * kOutRate;
  const uint64_t whole = fnv1a(mix_whole(s, frames));
  const uint64_t chunked = fnv1a(mix_chunked(s, frames, 4096 + 7));
  std::printf("    fnv1a whole %016llx chunked %016llx\n", static_cast<unsigned long long>(whole),
              static_cast<unsigned long long>(chunked));
  CHECK(whole == chunked);
  CHECK(whole == 0xc29f9bbc2dbc69efull);
}

TEST_CASE(rejects_malformed_arguments) {
  float out[8] = {};
  const float pcm[4] = {};
  const int meta[MIX_SLICE_STRIDE] = {0, 4, 1, 48000, 0, 4};
  double row[MIX_ENTRY_STRIDE] = {0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0};
  CHECK(mix_timeline_audio(out, 4, 48000, 3, pcm, 4, meta, 1, row, 1, nullptr, 0, 0) == CS_EINVAL);
  CHECK(mix_timeline_audio_range(out, 4, -1, 48000, 2, pcm, 4, meta, 1, row, 1, nullptr, 0, 0) == CS_EINVAL);
  CHECK(mix_timeline_audio(out, 4, 48000, 2, nullptr, 0, meta, 1, row, 1, nullptr, 0, 0) == CS_EINVAL);
  row[MIX_ENTRY_VOLUME_KEY_COUNT] = 2;  // curve points past the keyframe blob
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, 4, meta, 1, row, 1, nullptr, 0, 0) == CS_ERANGE);
  row[MIX_ENTRY_VOLUME_KEY_COUNT] = 0;
  row[MIX_ENTRY_SLICE_INDEX] = 5;  // unknown slice: skipped, not an error
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, 4, meta, 1, row, 1, nullptr, 0, 0) == 0);

  // A slice that runs past the blob is refused instead of read.
  row[MIX_ENTRY_SLICE_INDEX] = 0;
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, 3, meta, 1, row, 1, nullptr, 0, 0) == CS_ERANGE);
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, -1, meta, 1, row, 1, nullptr, 0, 0) == CS_EINVAL);
  const int shifted[MIX_SLICE_STRIDE] = {2, 4, 1, 48000, 0, 4};
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, 4, shifted, 1, row, 1, nullptr, 0, 0) == CS_ERANGE);
  const int stereo[MIX_SLICE_STRIDE] = {0, 4, 2, 48000, 0, 4};  // two planes: 8 floats
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, 4, stereo, 1, row, 1, nullptr, 0, 0) == CS_ERANGE);
  CHECK(mix_timeline_audio(out, 4, 48000, 2, pcm, 4, meta, 1, row, 1, nullptr, 0, 0) == CS_OK);
}

// ---------------------------------------------------------------------------
// Insert effects (EQ, compressor) and the bus limiter.

/** One-shot chain over planar PCM, the way the preview cache drives it. */
int process_insert_chain(float* planar, int frames, int channels, double rate, const double* effects, int count) {
  MixInsertChain* chain = insert_chain_create(rate, effects, count);
  if (!chain) return -1;
  const int rc = insert_chain_process(chain, planar, frames, channels);
  insert_chain_destroy(chain);
  return rc;
}

float sine_gen_1k_quarter(int, double t) { return static_cast<float>(0.25 * std::sin(2 * kPi * 1000.0 * t)); }

/** Steady-state gain (dB) a chain gives a `freq` sine, via the preview entry point. */
double measured_chain_gain_db(const std::vector<Fx>& chain, double freq, double rate) {
  const int n = static_cast<int>(rate);  // 1 s
  std::vector<float> plane(n);
  for (int i = 0; i < n; ++i) plane[i] = static_cast<float>(0.25 * std::sin(2 * kPi * freq * i / rate));
  std::vector<double> blob;
  for (const Fx& row : chain) blob.insert(blob.end(), row.begin(), row.end());
  CHECK(process_insert_chain(plane.data(), n, 1, rate, blob.data(), static_cast<int>(chain.size())) == 0);
  const int first = n / 2;
  std::vector<double> tail(plane.begin() + first, plane.end());
  // Whole cycles only matter for the fit, not the ratio: both sides use the same window.
  std::vector<double> ref(tail.size());
  for (size_t i = 0; i < ref.size(); ++i) ref[i] = 0.25 * std::sin(2 * kPi * freq * (first + i) / rate);
  return 20.0 * std::log10(tone_amplitude(tail, first, freq, rate) / tone_amplitude(ref, first, freq, rate));
}

TEST_CASE(eq_biquads_match_cookbook_magnitude) {
  // Peaking at its centre is exactly the cookbook gain; every type's measured
  // sine gain matches its own |H(e^jw)| within 0.1 dB.
  const double rate = 48000;
  const Fx blocks[] = {
      eq_block(MIX_FX_PEAKING, 1000, 6, 1.0),
      eq_block(MIX_FX_PEAKING, 2500, -9, 4.0),
      eq_block(MIX_FX_LOW_SHELF, 200, 6, 0.7071),
      eq_block(MIX_FX_HIGH_SHELF, 6000, -6, 0.7071),
      eq_block(MIX_FX_HIGH_PASS, 120, 0, 0.7071),
  };
  for (const Fx& row : blocks) {
    media_engine::Biquad biquad;
    CHECK(biquad.design(row.data(), rate));
    for (double freq : {60.0, 200.0, 1000.0, 2500.0, 6000.0, 12000.0}) {
      const double want = biquad.magnitude_db(freq, rate);
      const double got = measured_chain_gain_db({row}, freq, rate);
      CHECK_NEAR(got, want, 0.1);
    }
  }
  media_engine::Biquad peak;
  peak.design(blocks[0].data(), rate);
  CHECK_NEAR(peak.magnitude_db(1000, rate), 6.0, 1e-9);
  CHECK_NEAR(measured_chain_gain_db({blocks[0]}, 1000, rate), 6.0, 0.1);
  // Shelves reach their gain far from the corner; the high-pass rejects the stopband.
  CHECK_NEAR(measured_chain_gain_db({blocks[2]}, 30, rate), 6.0, 0.1);
  CHECK_NEAR(measured_chain_gain_db({blocks[3]}, 18000, rate), -6.0, 0.1);
  CHECK_LE(measured_chain_gain_db({blocks[4]}, 30, rate), -20.0);
}

TEST_CASE(eq_boost_reaches_export_mix_and_preview_alike) {
  // +6 dB peaking at 1 kHz on a 1 kHz tone: the export mix gets +6 dB, and the
  // preview's processed buffer (same C++, same rate, from the trim start) is
  // the exact pre-gain signal the mix hears.
  Schedule s;
  s.clips.push_back(make_clip(48000, 2.0, 1, sine_gen_1k_quarter));
  Entry e;
  e.duration = 1.5;
  e.buffer_offset = 0.25;
  e.fx = {eq_block(MIX_FX_PEAKING, 1000, 6, 1.0)};
  s.entries.push_back(e);
  const int frames = static_cast<int>(1.5 * kOutRate);
  const auto dry = mix_whole(s, frames);
  const auto wet = mix_fx(s, frames, frames);
  const int first = kOutRate / 2;
  const double gain_db = 20.0 * std::log10(tone_amplitude(channel(wet, 0, first, kOutRate / 2), first, 1000) /
                                           tone_amplitude(channel(dry, 0, first, kOutRate / 2), first, 1000));
  std::printf("    export +6 dB peaking at 1 kHz: %+.4f dB\n", gain_db);
  CHECK_NEAR(gain_db, 6.0, 0.1);

  std::vector<float> preview(s.clips[0].planes[0].begin() + kOutRate / 4, s.clips[0].planes[0].end());
  const Fx& row = e.fx[0];
  CHECK(process_insert_chain(preview.data(), static_cast<int>(preview.size()), 1, 48000, row.data(), 1) == 0);
  // Mono source at centre pan: both sides carry the source times sqrt(1/2).
  const float pan = static_cast<float>(std::cos(0.5 * kPi * 0.5));
  bool exact = true;
  for (int of = 0; of < frames; ++of) {
    if (wet[static_cast<size_t>(of) * 2] != preview[of] * pan) exact = false;
  }
  CHECK(exact);
}

TEST_CASE(compressor_reduces_hot_sine) {
  // -6 dBFS sine, threshold -20 dB, 4:1: the static curve wants
  // -20 + 14 / 4 = -16.5 dB out, i.e. 10.5 dB of reduction at the peak.
  const double amp = std::pow(10.0, -6.0 / 20.0);
  const int rate = 48000;
  const int n = 2 * rate;
  for (double knee : {0.0, 6.0}) {
    std::vector<float> plane(n);
    for (int i = 0; i < n; ++i) plane[i] = static_cast<float>(amp * std::sin(2 * kPi * 1000.0 * i / rate));
    const Fx row = compressor_block(-20, 4, 0.002, 0.2, knee);
    CHECK(process_insert_chain(plane.data(), n, 1, rate, row.data(), 1) == 0);
    std::vector<double> tail(plane.begin() + rate, plane.end());
    const double out_db = 20.0 * std::log10(tone_amplitude(tail, rate, 1000));
    const double reduction = out_db - (-6.0);
    std::printf("    knee %.0f dB: reduction %.2f dB (static curve -10.50)\n", knee, reduction);
    CHECK_NEAR(reduction, -10.5, 1.0);
  }
  // Below the knee the compressor is transparent; make-up gain applies on top.
  std::vector<float> quiet(rate);
  for (int i = 0; i < rate; ++i) quiet[i] = static_cast<float>(0.01 * std::sin(2 * kPi * 1000.0 * i / rate));
  const Fx makeup = compressor_block(-20, 4, 0.002, 0.2, 6, 3);
  CHECK(process_insert_chain(quiet.data(), rate, 1, rate, makeup.data(), 1) == 0);
  std::vector<double> quiet_tail(quiet.begin() + rate / 2, quiet.end());
  CHECK_NEAR(20.0 * std::log10(tone_amplitude(quiet_tail, rate / 2, 1000) / 0.01), 3.0, 0.01);
}

TEST_CASE(insert_chain_blocks_match_one_shot_bitwise) {
  // The preview cache processes long clips in blocks; state carries over, so
  // blocking never changes a sample.
  g_lcg = 77;
  const Clip clip = make_clip(48000, 1.0, 2, program_gen);
  std::vector<double> blob;
  for (const Fx& row : {eq_block(MIX_FX_PEAKING, 2000, 8, 3), eq_block(MIX_FX_HIGH_PASS, 90, 0, 0.7071),
                        compressor_block(-26, 6, 0.003, 0.08, 4, 2)}) {
    blob.insert(blob.end(), row.begin(), row.end());
  }
  const int n = clip.frames();
  std::vector<float> whole;
  for (const auto& plane : clip.planes) whole.insert(whole.end(), plane.begin(), plane.end());
  CHECK(process_insert_chain(whole.data(), n, 2, 48000, blob.data(), 3) == 0);

  MixInsertChain* chain = insert_chain_create(48000, blob.data(), 3);
  std::vector<float> blocked(whole.size());
  for (int begin = 0; begin < n; begin += 1000) {
    const int len = std::min(1000, n - begin);
    std::vector<float> block(static_cast<size_t>(len) * 2);
    for (int c = 0; c < 2; ++c) {
      std::copy_n(clip.planes[c].begin() + begin, len, block.begin() + static_cast<size_t>(c) * len);
    }
    CHECK(insert_chain_process(chain, block.data(), len, 2) == 0);
    for (int c = 0; c < 2; ++c) {
      std::copy_n(block.begin() + static_cast<size_t>(c) * len, len,
                  blocked.begin() + static_cast<size_t>(c) * n + begin);
    }
  }
  insert_chain_destroy(chain);
  CHECK(std::memcmp(whole.data(), blocked.data(), whole.size() * sizeof(float)) == 0);
}

TEST_CASE(compressor_links_stereo_on_louder_channel) {
  // A hot left and a quiet right get the same gain, so the image does not shift.
  const int rate = 48000;
  const int n = rate;
  std::vector<float> planar(static_cast<size_t>(n) * 2);
  for (int i = 0; i < n; ++i) {
    planar[i] = static_cast<float>(0.5 * std::sin(2 * kPi * 440.0 * i / rate));
    planar[n + i] = static_cast<float>(0.05 * std::sin(2 * kPi * 440.0 * i / rate));
  }
  const std::vector<float> dry = planar;
  const Fx row = compressor_block(-20, 8, 0.002, 0.1, 0);
  CHECK(process_insert_chain(planar.data(), n, 2, rate, row.data(), 1) == 0);
  double worst = 0;
  for (int i = n / 2; i < n; ++i) {
    if (std::fabs(dry[i]) < 0.1) continue;
    const double gl = planar[i] / dry[i];
    const double gr = planar[n + i] / dry[n + i];
    worst = std::max(worst, std::fabs(gl - gr));
  }
  CHECK_LE(worst, 1e-5);
}

Schedule hot_schedule() {
  g_lcg = 31337;
  Schedule s;
  s.clips.push_back(make_clip(44100, 3.0, 2, program_gen));
  s.clips.push_back(make_clip(48000, 3.0, 2, noise_gen));
  Entry a;
  a.duration = 2.5;
  a.volume = 2.0;  // the 0..2 clamp alone lets this reach ~2x full scale
  a.fade_in = 0.05;
  Entry b;
  b.clip = 1;
  b.timeline_start = 0.6;
  b.duration = 1.5;
  b.volume = 1.5;
  b.fx = {eq_block(MIX_FX_LOW_SHELF, 150, 9, 0.7071)};
  s.entries = {a, b};
  return s;
}

TEST_CASE(limiter_never_exceeds_ceiling) {
  const Schedule s = hot_schedule();
  const int frames = 3 * kOutRate;
  const float ceiling = static_cast<float>(std::pow(10.0, -1.0 / 20.0));
  float dry_peak = 0.f;
  for (float v : mix_fx(s, frames, frames)) dry_peak = std::max(dry_peak, std::fabs(v));
  CHECK_GE(dry_peak, 1.5f);  // the fixture really is hot
  for (int out_ch : {2, 1}) {
    for (double lookahead : {0.0005, 0.005, 0.02}) {
      for (int chunk : {frames, 1024, 4096 + 3}) {
        const auto out = mix_fx(s, frames, chunk, {limiter_block(-1.0, lookahead, 0.08)}, out_ch);
        float peak = 0.f;
        for (float v : out) peak = std::max(peak, std::fabs(v));
        CHECK_LE(peak, ceiling);
        // Limiting, not muting: the loud stretch still sits at the ceiling.
        CHECK_GE(peak, ceiling * 0.97f);
      }
    }
  }
}

TEST_CASE(limiter_is_transparent_and_latency_compensated) {
  // Material under the ceiling passes bit-for-bit: the look-ahead delay is
  // hidden, so output frame N is still timeline frame N.
  g_lcg = 5;
  Schedule s;
  s.clips.push_back(make_clip(48000, 2.0, 2, noise_gen));
  Entry e;
  e.timeline_start = 0.3;
  e.duration = 1.2;
  e.volume = 0.4;
  e.fade_in = 0.1;
  s.entries.push_back(e);
  const int frames = 2 * kOutRate;
  const auto dry = mix_whole(s, frames);
  for (int chunk : {frames, 1000}) {
    const auto wet = mix_fx(s, frames, chunk, {limiter_block(-1.0)});
    CHECK(std::memcmp(dry.data(), wet.data(), dry.size() * sizeof(float)) == 0);
  }
}

TEST_CASE(zero_effect_session_matches_legacy_bitwise) {
  // No effect blocks (or only bypassed ones) and no limiter: the fx entry
  // point produces today's mix byte for byte, whole or chunked.
  Schedule s = automation_schedule();
  const int frames = 3 * kOutRate;
  for (int flags : {0, static_cast<int>(MIX_FLAG_LINEAR_RESAMPLE)}) {
    const auto legacy = mix_whole(s, frames, flags);
    for (int chunk : {frames, 1024, 3 * 4096 + 5}) {
      const auto plain = mix_fx(s, frames, chunk, {}, 2, flags);
      CHECK(std::memcmp(legacy.data(), plain.data(), legacy.size() * sizeof(float)) == 0);
      const auto empty = mix_fx(s, frames, chunk, {}, 2, flags | MIX_FLAG_EFFECTS);
      CHECK(std::memcmp(legacy.data(), empty.data(), legacy.size() * sizeof(float)) == 0);
    }
  }
  Fx bypassed = eq_block(MIX_FX_PEAKING, 1000, 12, 1);
  bypassed[MIX_FX_ENABLED] = 0;
  Fx bypassed_limiter = limiter_block(-1);
  bypassed_limiter[MIX_FX_ENABLED] = 0;
  for (Entry& e : s.entries) e.fx = {bypassed};
  const auto legacy = mix_whole(s, frames);
  const auto off = mix_fx(s, frames, 2048, {bypassed_limiter});
  CHECK(std::memcmp(legacy.data(), off.data(), legacy.size() * sizeof(float)) == 0);
}

TEST_CASE(fx_chunked_mix_matches_whole_mix_bitwise) {
  Schedule s = automation_schedule();
  s.entries[0].fx = {eq_block(MIX_FX_HIGH_PASS, 80, 0, 0.7071), eq_block(MIX_FX_PEAKING, 3000, 5, 2),
                     compressor_block(-24, 3, 0.005, 0.15, 6, 4)};
  s.entries[1].fx = {compressor_block(-30, 10, 0.001, 0.05, 0)};
  s.entries[2].fx = {eq_block(MIX_FX_HIGH_SHELF, 8000, -8, 0.7071), eq_block(MIX_FX_LOW_SHELF, 100, 4, 0.7071)};
  const int frames = 3 * kOutRate;
  const std::vector<Fx> bus = {limiter_block(-3.0, 0.003, 0.05)};
  for (int flags : {static_cast<int>(MIX_FLAG_EFFECTS), MIX_FLAG_EFFECTS | MIX_FLAG_LINEAR_RESAMPLE}) {
    const auto whole = mix_fx(s, frames, frames, bus, 2, flags);
    for (int chunk : {1024, 777, 3 * 4096 + 5}) {
      const auto chunked = mix_fx(s, frames, chunk, bus, 2, flags);
      CHECK(std::memcmp(whole.data(), chunked.data(), whole.size() * sizeof(float)) == 0);
    }
  }
}

TEST_CASE(fx_session_rejects_malformed_calls) {
  const double fx[MIX_FX_STRIDE] = {MIX_FX_PEAKING, 1, 1000, 6, 1, 0, 0, 0, 0, 0};
  CHECK(mix_fx_session_create(0, 2, 1, fx, 1, 0, 0) == nullptr);
  CHECK(mix_fx_session_create(48000, 3, 1, fx, 1, 0, 0) == nullptr);
  CHECK(mix_fx_session_create(48000, 2, 1, fx, 1, 0, 2) == nullptr);  // bus chain past the blob
  CHECK(mix_fx_session_create(48000, 2, 1, nullptr, 1, 0, 0) == nullptr);

  float out[8] = {};
  const float pcm[4] = {};
  const int meta[MIX_SLICE_STRIDE] = {0, 4, 1, 48000, 0, 4};
  double row[MIX_ENTRY_FX_STRIDE] = {0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0};
  // Effects need a session: the stateless entry point refuses the flag.
  CHECK(mix_timeline_audio_range(out, 4, 0, 48000, 2, pcm, 4, meta, 1, row, 1, nullptr, 0, MIX_FLAG_EFFECTS) == CS_EINVAL);

  MixFxSession* session = mix_fx_session_create(48000, 2, 1, fx, 1, 0, 0);
  CHECK(session != nullptr);
  CHECK(mix_fx_session_latency(session) == 0);
  CHECK(mix_fx_session_range(session, out, 4, 4, pcm, 4, meta, 1, row, 1, nullptr, 0, MIX_FLAG_EFFECTS) == CS_ESTATE);
  row[MIX_ENTRY_FX_COUNT] = 2;  // chain past the effect blob
  CHECK(mix_fx_session_range(session, out, 4, 0, pcm, 4, meta, 1, row, 1, nullptr, 0, MIX_FLAG_EFFECTS) == CS_ERANGE);
  row[MIX_ENTRY_FX_COUNT] = 1;
  row[MIX_ENTRY_FX_STATE] = 1;  // state slot past `state_count`
  CHECK(mix_fx_session_range(session, out, 4, 0, pcm, 4, meta, 1, row, 1, nullptr, 0, MIX_FLAG_EFFECTS) == CS_ERANGE);
  row[MIX_ENTRY_FX_STATE] = 0;
  CHECK(mix_fx_session_range(session, out, 4, 0, pcm, 4, meta, 1, row, 1, nullptr, 0, MIX_FLAG_EFFECTS) == 0);
  CHECK(mix_fx_session_range(session, out, 4, 4, pcm, 4, meta, 1, row, 1, nullptr, 0, MIX_FLAG_EFFECTS) == 0);
  mix_fx_session_destroy(session);
  mix_fx_session_destroy(nullptr);

  CHECK(insert_chain_create(0, fx, 1) == nullptr);
  CHECK(insert_chain_create(48000, nullptr, 1) == nullptr);
  MixInsertChain* chain = insert_chain_create(48000, fx, 1);
  CHECK(chain != nullptr);
  float plane[4] = {};
  CHECK(insert_chain_process(chain, plane, 4, 3) == CS_EINVAL);
  CHECK(insert_chain_process(nullptr, plane, 4, 1) == CS_EINVAL);
  CHECK(insert_chain_process(chain, plane, 4, 1) == 0);
  insert_chain_destroy(chain);
  insert_chain_destroy(nullptr);
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
