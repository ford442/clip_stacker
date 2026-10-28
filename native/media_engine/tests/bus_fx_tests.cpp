// Host tests for the bus layer: true-peak detection and limiting, the
// BS.1770 loudness meter (EBU Tech 3341 / 3342 minimum-requirement signals,
// synthesised), gate / de-esser / sidechain ducker, the bus graph and its
// session, chunk invariance, and denormal behaviour.
//
//   bus_fx_tests --list
//   bus_fx_tests loudness duck

#include "audio_mix.h"
#include "bus.h"
#include "effects.h"
#include "host_test.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace {

constexpr int kRate = 48000;
constexpr double kPi = 3.14159265358979323846;

using Fx = std::vector<double>;

Fx row(int kind) {
  Fx r(MIX_FX_STRIDE, 0.0);
  r[MIX_FX_KIND] = kind;
  r[MIX_FX_ENABLED] = 1;
  return r;
}

Fx eq(int kind, double freq, double gain_db, double q) {
  Fx r = row(kind);
  r[MIX_FX_FREQ] = freq;
  r[MIX_FX_GAIN_DB] = gain_db;
  r[MIX_FX_Q] = q;
  return r;
}

Fx compressor(double threshold_db, double ratio, double attack, double release, double knee_db = 6,
              double makeup_db = 0) {
  Fx r = row(MIX_FX_COMPRESSOR);
  r[MIX_FX_THRESHOLD_DB] = threshold_db;
  r[MIX_FX_RATIO] = ratio;
  r[MIX_FX_ATTACK] = attack;
  r[MIX_FX_RELEASE] = release;
  r[MIX_FX_KNEE_DB] = knee_db;
  r[MIX_FX_GAIN_DB] = makeup_db;
  return r;
}

Fx limiter(double ceiling_db, double lookahead = 0.005, double release = 0.1) {
  Fx r = row(MIX_FX_LIMITER);
  r[MIX_FX_THRESHOLD_DB] = ceiling_db;
  r[MIX_FX_ATTACK] = lookahead;
  r[MIX_FX_RELEASE] = release;
  return r;
}

Fx gate(double threshold_db, double range_db, double attack, double hold, double release) {
  Fx r = row(MIX_FX_GATE);
  r[MIX_FX_THRESHOLD_DB] = threshold_db;
  r[MIX_FX_RANGE_DB] = range_db;
  r[MIX_FX_ATTACK] = attack;
  r[MIX_FX_HOLD] = hold;
  r[MIX_FX_RELEASE] = release;
  return r;
}

Fx deesser(double freq, double threshold_db, double ratio, double range_db, double attack = 0.001,
           double release = 0.05) {
  Fx r = row(MIX_FX_DEESSER);
  r[MIX_FX_FREQ] = freq;
  r[MIX_FX_THRESHOLD_DB] = threshold_db;
  r[MIX_FX_RATIO] = ratio;
  r[MIX_FX_RANGE_DB] = range_db;
  r[MIX_FX_ATTACK] = attack;
  r[MIX_FX_RELEASE] = release;
  return r;
}

Fx ducker(int key, double depth_db, double threshold_db, double attack, double hold, double release) {
  Fx r = row(MIX_FX_DUCKER);
  r[MIX_FX_KEY] = key;
  r[MIX_FX_RANGE_DB] = depth_db;
  r[MIX_FX_THRESHOLD_DB] = threshold_db;
  r[MIX_FX_ATTACK] = attack;
  r[MIX_FX_HOLD] = hold;
  r[MIX_FX_RELEASE] = release;
  return r;
}

/** Packed graph layout: lane chains, master chain, final stage. */
struct Layout {
  std::vector<std::vector<Fx>> lanes;
  std::vector<Fx> master;
  std::vector<Fx> final_stage;
  double gain_db = 0;

  void pack(std::vector<double>* effects, std::vector<int>* buses, int* master_first, int* final_first) const {
    effects->clear();
    buses->clear();
    auto append = [&](const std::vector<Fx>& rows) {
      const int first = static_cast<int>(effects->size() / MIX_FX_STRIDE);
      for (const Fx& r : rows) effects->insert(effects->end(), r.begin(), r.end());
      return first;
    };
    for (const auto& lane : lanes) {
      const int first = append(lane);
      buses->insert(buses->end(), {first, static_cast<int>(lane.size())});
    }
    *master_first = append(master);
    *final_first = append(final_stage);
    if (effects->empty()) effects->push_back(0.0);
  }
};

struct Graph {
  BusGraphHandle* handle = nullptr;
  int lanes = 0;
  explicit Graph(const Layout& l, int flags = 0, int channels = 2) {
    std::vector<double> effects;
    std::vector<int> buses;
    int master_first = 0;
    int final_first = 0;
    l.pack(&effects, &buses, &master_first, &final_first);
    lanes = static_cast<int>(l.lanes.size());
    handle = bus_graph_create(kRate, channels, effects.data(), static_cast<int>(effects.size() / MIX_FX_STRIDE),
                              buses.data(), lanes, master_first, static_cast<int>(l.master.size()), l.gain_db,
                              final_first, static_cast<int>(l.final_stage.size()), flags);
    CHECK(handle != nullptr);
  }
  ~Graph() { bus_graph_destroy(handle); }
  Graph(const Graph&) = delete;
  Graph& operator=(const Graph&) = delete;
};

/**
 * Run `inputs` (one interleaved stereo signal per lane, all the same length)
 * through a graph in blocks of `block` frames. The direct input is silent.
 */
std::vector<float> run_graph(Graph& g, const std::vector<std::vector<float>>& inputs, int block,
                             std::vector<std::vector<double>>* meter_reads = nullptr) {
  const int frames = static_cast<int>(inputs[0].size() / 2);
  std::vector<float> out(static_cast<size_t>(frames) * 2);
  for (int begin = 0; begin < frames; begin += block) {
    const int n = std::min(block, frames - begin);
    std::vector<float> lanes(static_cast<size_t>(g.lanes + 1) * n * 2, 0.f);
    for (int l = 0; l < g.lanes; ++l) {
      std::copy_n(inputs[l].begin() + static_cast<size_t>(begin) * 2, static_cast<size_t>(n) * 2,
                  lanes.begin() + static_cast<size_t>(l) * n * 2);
    }
    CHECK(bus_graph_process(g.handle, lanes.data(), out.data() + static_cast<size_t>(begin) * 2, n) == 0);
    if (meter_reads) {
      std::vector<double> m(64);
      m.resize(static_cast<size_t>(bus_graph_meters(g.handle, m.data(), 64)));
      meter_reads->push_back(m);
    }
  }
  return out;
}

std::vector<float> sine(double seconds, double freq, double amplitude, double phase = 0.0, int rate = kRate) {
  const int n = static_cast<int>(std::lround(seconds * rate));
  std::vector<float> x(static_cast<size_t>(n) * 2);
  for (int i = 0; i < n; ++i) {
    const float v = static_cast<float>(amplitude * std::sin(2 * kPi * freq * i / rate + phase));
    x[2 * i] = v;
    x[2 * i + 1] = v;
  }
  return x;
}

/** 10 ms raised-cosine fade in and out, as Tech 3341 prescribes for its true-peak tones. */
std::vector<float> tapered(std::vector<float> x) {
  const int frames = static_cast<int>(x.size() / 2);
  const int ramp = std::min(frames / 2, kRate / 100);
  for (int i = 0; i < ramp; ++i) {
    const float w = static_cast<float>(0.5 - 0.5 * std::cos(kPi * i / ramp));
    for (int c = 0; c < 2; ++c) {
      x[2 * i + c] *= w;
      x[2 * (frames - 1 - i) + c] *= w;
    }
  }
  return x;
}

std::vector<float> silence(double seconds) {
  return std::vector<float>(static_cast<size_t>(std::lround(seconds * kRate)) * 2, 0.f);
}

std::vector<float> concat(std::initializer_list<std::vector<float>> parts) {
  std::vector<float> out;
  for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}

double dbfs_amplitude(double dbfs) { return std::pow(10.0, dbfs / 20.0); }

/** A 1 kHz in-phase stereo tone at `dbfs` per-channel peak (EBU Tech 3341 #1 style). */
std::vector<float> tone(double seconds, double dbfs) { return sine(seconds, 1000.0, dbfs_amplitude(dbfs)); }

uint32_t g_lcg = 1;
float noise() {
  g_lcg = g_lcg * 1664525u + 1013904223u;
  return static_cast<float>(static_cast<int32_t>(g_lcg)) / 2147483648.0f;
}

/** Busy programme-like material: a chord, noise bursts, transients. */
std::vector<float> programme(double seconds, double level, uint32_t seed) {
  g_lcg = seed;
  const int n = static_cast<int>(std::lround(seconds * kRate));
  std::vector<float> x(static_cast<size_t>(n) * 2);
  for (int i = 0; i < n; ++i) {
    const double t = static_cast<double>(i) / kRate;
    const double env = 0.55 + 0.45 * std::sin(2 * kPi * 0.7 * t);
    const double burst = std::fmod(t, 0.5) < 0.04 ? 1.0 : 0.25;
    for (int c = 0; c < 2; ++c) {
      const double v = 0.4 * std::sin(2 * kPi * (220.0 + 3 * c) * t) + 0.25 * std::sin(2 * kPi * 1760.0 * t + c) +
                       0.3 * burst * noise();
      x[2 * i + c] = static_cast<float>(level * env * v);
    }
  }
  return x;
}

std::vector<double> measure(const std::vector<float>& x, int block = 4096) {
  LoudnessMeterHandle* m = loudness_meter_create(kRate, 2);
  CHECK(m != nullptr);
  const int frames = static_cast<int>(x.size() / 2);
  for (int begin = 0; begin < frames; begin += block) {
    CHECK(loudness_meter_process(m, x.data() + static_cast<size_t>(begin) * 2, std::min(block, frames - begin)) ==
          0);
  }
  std::vector<double> out(6);
  CHECK(loudness_meter_read(m, out.data(), 6) == 6);
  loudness_meter_destroy(m);
  return out;
}

/** Output true peak (dBTP) of a whole signal, with silence appended so the detector flushes. */
double true_peak_db(std::vector<float> x) {
  const std::vector<float> tail = silence(0.01);
  x.insert(x.end(), tail.begin(), tail.end());
  return measure(x)[MIX_METER_TRUE_PEAK];
}

// ---------------------------------------------------------------------------
// Loudness meter (EBU Tech 3341 Table 1, Tech 3342 Table 1)

TEST_CASE(loudness_reads_stereo_1k_sine_at_its_level) {
  // Tech 3341 #1 and #2: M, S, I = level +/- 0.1.
  for (double level : {-23.0, -33.0}) {
    const auto m = measure(tone(20.0, level));
    CHECK_NEAR(m[MIX_METER_MOMENTARY], level, 0.1);
    CHECK_NEAR(m[MIX_METER_SHORT_TERM], level, 0.1);
    CHECK_NEAR(m[MIX_METER_INTEGRATED], level, 0.1);
  }
}

TEST_CASE(integrated_loudness_gates_tech3341_cases_3_to_5) {
  // #3: the relative gate drops the -36 dBFS tails.
  CHECK_NEAR(measure(concat({tone(10, -36), tone(60, -23), tone(10, -36)}))[MIX_METER_INTEGRATED], -23.0, 0.1);
  // #4: the absolute gate drops the -72 dBFS ends.
  CHECK_NEAR(measure(concat({tone(10, -72), tone(10, -36), tone(60, -23), tone(10, -36), tone(10, -72)}))
                 [MIX_METER_INTEGRATED],
             -23.0, 0.1);
  // #5: both levels are above the gate and average to -23.
  CHECK_NEAR(measure(concat({tone(20, -26), tone(20.1, -20), tone(20, -26)}))[MIX_METER_INTEGRATED], -23.0, 0.1);
  // Silence is not loud: no block passes the absolute gate.
  CHECK(std::isinf(measure(silence(2))[MIX_METER_INTEGRATED]));
}

TEST_CASE(short_term_and_momentary_follow_tech3341_cases_9_and_12) {
  // #9: 1.34 s at -20 / 1.66 s at -30, repeated: S = -23 once 3 s are in.
  std::vector<float> nine;
  for (int i = 0; i < 5; ++i) nine = concat({nine, tone(1.34, -20), tone(1.66, -30)});
  CHECK_NEAR(measure(nine)[MIX_METER_SHORT_TERM], -23.0, 0.1);
  // #12: 0.18 s at -20 / 0.22 s at -30, repeated: M = -23 after 1 s.
  std::vector<float> twelve;
  for (int i = 0; i < 25; ++i) twelve = concat({twelve, tone(0.18, -20), tone(0.22, -30)});
  CHECK_NEAR(measure(twelve)[MIX_METER_MOMENTARY], -23.0, 0.1);
}

TEST_CASE(loudness_range_matches_tech3342_cases_1_to_4) {
  CHECK_NEAR(measure(concat({tone(20, -20), tone(20, -30)}))[MIX_METER_RANGE], 10.0, 1.0);
  CHECK_NEAR(measure(concat({tone(20, -20), tone(20, -15)}))[MIX_METER_RANGE], 5.0, 1.0);
  CHECK_NEAR(measure(concat({tone(20, -40), tone(20, -20)}))[MIX_METER_RANGE], 20.0, 1.0);
  CHECK_NEAR(measure(concat({tone(20, -50), tone(20, -35), tone(20, -20), tone(20, -35), tone(20, -50)}))
                 [MIX_METER_RANGE],
             15.0, 1.0);
}

TEST_CASE(true_peak_reads_tech3341_cases_15_to_19) {
  // Expected -6.0 / +3.0 dBTP, tolerance +0.2 / -0.4.
  struct Case {
    double divisor;
    double amplitude;
    double phase_deg;
    double expected;
  };
  const Case cases[] = {{4, 0.5, 0.0, -6.0}, {4, 0.5, 45.0, -6.0}, {6, 0.5, 60.0, -6.0}, {8, 0.5, 67.5, -6.0},
                        {4, 1.41, 45.0, 3.0}};
  for (const Case& c : cases) {
    const auto x = tapered(sine(1.0, kRate / c.divisor, c.amplitude, c.phase_deg * kPi / 180.0));
    const double tp = true_peak_db(x);
    CHECK_GE(tp, c.expected - 0.4);
    CHECK_LE(tp, c.expected + 0.2);
  }
  // The point of #16: a sample-peak reading of fs/4 at 45 degrees is 3 dB low.
  const auto m = measure(tapered(sine(1.0, kRate / 4.0, 0.5, kPi / 4)));
  CHECK_NEAR(m[MIX_METER_SAMPLE_PEAK], -9.03, 0.05);
}

TEST_CASE(momentary_reads_silence_once_the_programme_stops) {
  // The K-filters ring down for a while after the last sample: that tail is
  // silence (-inf), not a reading hundreds of LU down.
  // 10 s, so the partial gating blocks at the end barely move the integrated value.
  const auto m = measure(concat({tone(10.0, -20), silence(5.0)}));
  CHECK(std::isinf(m[MIX_METER_MOMENTARY]) && m[MIX_METER_MOMENTARY] < 0);
  CHECK(std::isinf(m[MIX_METER_SHORT_TERM]) && m[MIX_METER_SHORT_TERM] < 0);
  CHECK_NEAR(m[MIX_METER_INTEGRATED], -20.0, 0.1);
}

TEST_CASE(meter_readings_do_not_depend_on_chunking) {
  const auto x = programme(7.3, 0.5, 11);
  const auto whole = measure(x, static_cast<int>(x.size() / 2));
  for (int block : {128, 1000, 4800, 4801}) {
    const auto chunked = measure(x, block);
    for (int i = 0; i < 6; ++i) CHECK(std::memcmp(&whole[i], &chunked[i], sizeof(double)) == 0);
  }
}

// ---------------------------------------------------------------------------
// True-peak limiter

/** Signals whose inter-sample peaks exceed their sample peaks. */
std::vector<std::vector<float>> inter_sample_signals() {
  std::vector<std::vector<float>> signals;
  // Tech 3341 #19: fs/4 at 45 degrees, +3 dBTP with sample peaks at 0 dBFS.
  signals.push_back(tapered(sine(1.0, kRate / 4.0, 1.41, kPi / 4)));
  signals.push_back(tapered(sine(1.0, kRate / 6.0, 1.2, kPi / 3)));
  // Near-Nyquist content riding on a loud low tone.
  {
    auto x = sine(1.0, 100.0, 0.9);
    const auto hf = sine(1.0, 21000.0, 0.6, 0.3);
    for (size_t i = 0; i < x.size(); ++i) x[i] += hf[i];
    signals.push_back(x);
  }
  signals.push_back(programme(2.0, 1.8, 7));
  // Hard-edged bursts: attack transients the look-ahead must catch.
  {
    auto x = silence(1.0);
    const auto loud = sine(0.02, kRate / 4.0, 1.41, kPi / 4);
    for (int k = 0; k < 6; ++k) std::copy(loud.begin(), loud.end(), x.begin() + static_cast<size_t>(k) * 16000);
    signals.push_back(x);
  }
  return signals;
}

TEST_CASE(limiter_holds_true_peak_ceiling_on_inter_sample_peaks) {
  for (double ceiling : {-1.0, -2.0, -0.1}) {
    for (double lookahead : {0.0, 0.0015, 0.005, 0.02}) {
      for (const auto& x : inter_sample_signals()) {
        Layout l;
        l.lanes = {{}};
        l.final_stage = {limiter(ceiling, lookahead, 0.08)};
        Graph g(l);
        // Run the input's tail out of the look-ahead too: truncating the
        // output mid-signal would itself create an inter-sample peak.
        const auto y = run_graph(g, {concat({x, silence(0.05)})}, 1024);
        CHECK_LE(true_peak_db(y), ceiling);
      }
    }
  }
}

TEST_CASE(sample_peak_limiting_fails_the_inter_sample_case) {
  // What a sample-peak limiter delivers on Tech 3341 #19: samples pulled to
  // the ceiling, true peak still ~3 dB over it. The true-peak limiter above
  // passes the same signal.
  const double ceiling = -1.0;
  auto x = tapered(sine(1.0, kRate / 4.0, 1.41, kPi / 4));
  float sample_peak = 0.f;
  for (float v : x) sample_peak = std::max(sample_peak, std::fabs(v));
  const float scale = static_cast<float>(dbfs_amplitude(ceiling) / sample_peak);
  for (float& v : x) v *= scale;
  CHECK_GE(true_peak_db(x), ceiling + 2.5);
}

TEST_CASE(limiter_is_transparent_below_the_ceiling) {
  const auto x = programme(2.0, 0.2, 3);
  Layout l;
  l.lanes = {{}};
  l.final_stage = {limiter(-1.0)};
  Graph g(l);
  const int latency = bus_graph_latency(g.handle);
  CHECK(latency == media_engine::TruePeakDetector::kDelay + 240);
  const auto y = run_graph(g, {x}, 777);
  // Delayed by the latency, otherwise bit-identical.
  const size_t shift = static_cast<size_t>(latency) * 2;
  CHECK(std::memcmp(x.data(), y.data() + shift, (y.size() - shift) * sizeof(float)) == 0);
}

// ---------------------------------------------------------------------------
// Gate, de-esser, ducker

TEST_CASE(gate_attenuates_the_floor_and_passes_the_signal) {
  const auto x = concat({tone(0.5, -20), tone(1.0, -60), tone(0.5, -20)});
  Layout l;
  l.lanes = {{gate(-40, 30, 0.0005, 0.02, 0.05)}};
  Graph g(l);
  const auto y = run_graph(g, {x}, 512);
  auto rms = [](const std::vector<float>& v, double from, double to) {
    double sum = 0;
    const size_t a = static_cast<size_t>(from * kRate) * 2;
    const size_t b = static_cast<size_t>(to * kRate) * 2;
    for (size_t i = a; i < b; ++i) sum += static_cast<double>(v[i]) * v[i];
    return 10 * std::log10(sum / static_cast<double>(b - a));
  };
  CHECK_NEAR(rms(y, 0.1, 0.45) - rms(x, 0.1, 0.45), 0.0, 0.01);       // open: untouched
  CHECK_NEAR(rms(y, 0.9, 1.4) - rms(x, 0.9, 1.4), -30.0, 0.5);        // closed: range
  CHECK_NEAR(rms(y, 1.6, 1.95) - rms(x, 1.6, 1.95), 0.0, 0.05);       // reopened
}

TEST_CASE(deesser_cuts_only_the_band_above_the_split) {
  // Low content alone stays bit-exact: the high band never crosses threshold.
  const auto low = sine(1.0, 300.0, 0.3);
  Layout l;
  l.lanes = {{deesser(6000, -30, 4, 8)}};
  {
    Graph g(l);
    const auto y = run_graph(g, {low}, 128);
    CHECK(std::memcmp(low.data(), y.data(), y.size() * sizeof(float)) == 0);
  }
  // Add sibilance: it comes down by about the range, the 300 Hz tone stays.
  auto mixed = low;
  const auto ess = sine(1.0, 8000.0, 0.3);
  for (size_t i = 0; i < mixed.size(); ++i) mixed[i] += ess[i];
  Graph g(l);
  const auto y = run_graph(g, {mixed}, 128);
  std::vector<double> yl(kRate / 2);
  for (int i = 0; i < kRate / 2; ++i) yl[i] = y[static_cast<size_t>(kRate / 2 + i) * 2];
  auto amp = [&](double freq) {
    double s = 0, c = 0;
    for (size_t i = 0; i < yl.size(); ++i) {
      const double ph = 2 * kPi * freq * static_cast<double>(kRate / 2 + static_cast<int>(i)) / kRate;
      s += yl[i] * std::sin(ph);
      c += yl[i] * std::cos(ph);
    }
    return 2.0 * std::sqrt(s * s + c * c) / static_cast<double>(yl.size());
  };
  // A high shelf at 6 kHz cuts 8 kHz by most of the 8 dB range.
  const double ess_db = 20 * std::log10(amp(8000) / 0.3);
  CHECK_LE(ess_db, -5.0);
  CHECK_GE(ess_db, -8.0);
  CHECK_NEAR(20 * std::log10(amp(300) / 0.3), 0.0, 0.1);
}

/** Gain the ducked lane (a constant 0.5 DC "music" bed) gets, frame by frame. */
std::vector<double> duck_gain(const std::vector<float>& key, const Fx& duck_row, int block) {
  const std::vector<float> bed(key.size(), 0.5f);
  Layout l;
  l.lanes = {{}, {duck_row}};
  Graph with_bed(l);
  Graph key_only(l);
  const auto mixed = run_graph(with_bed, {key, bed}, block);
  const auto alone = run_graph(key_only, {key, std::vector<float>(key.size(), 0.f)}, block);
  std::vector<double> gain(key.size() / 2);
  for (size_t i = 0; i < gain.size(); ++i) gain[i] = (mixed[2 * i] - alone[2 * i]) / 0.5;
  return gain;
}

TEST_CASE(sidechain_duck_reaches_depth_within_attack_and_recovers_within_release) {
  const double depth = 12, attack = 0.05, hold = 0.1, release = 0.3;
  const double on = 1.0, off = 2.0;
  const auto key = concat({silence(on), tone(off - on, -20), silence(1.5)});
  for (int block : {128, 4096}) {
    const auto g = duck_gain(key, ducker(0, depth, -40, attack, hold, release), block);
    const double floor = dbfs_amplitude(-depth);
    const int onset = static_cast<int>(on * kRate);
    // The tone starts at phase 0: its first sample over -40 dBFS is a few frames in.
    int first_hot = onset;
    while (std::fabs(key[2 * first_hot]) < dbfs_amplitude(-40)) ++first_hot;
    for (int i = 0; i < first_hot; ++i) CHECK(g[i] == 1.0);
    CHECK_NEAR(g[first_hot + static_cast<int>(attack * kRate)], floor, 1e-4);
    CHECK_GE(g[first_hot + static_cast<int>(attack * kRate) / 2], floor * 1.5);  // ramping, not a step
    // Last hot sample of the key, then hold, then the release ramp.
    int last_hot = static_cast<int>(off * kRate) - 1;
    while (std::fabs(key[2 * last_hot]) < dbfs_amplitude(-40)) --last_hot;
    CHECK_NEAR(g[last_hot + static_cast<int>(hold * kRate)], floor, 1e-4);
    const int recovered = last_hot + static_cast<int>((hold + release) * kRate) + 2;
    CHECK_NEAR(g[recovered], 1.0, 1e-5);
    CHECK(g[recovered + 100] == 1.0);
  }
}

TEST_CASE(duck_key_must_be_packed_before_the_ducked_lane) {
  // A key at or after its own lane would need a frame that is not mixed yet:
  // the ducker is ignored rather than reading stale audio.
  const auto key = tone(1.0, -10);
  const std::vector<float> bed(key.size(), 0.5f);
  Layout l;
  l.lanes = {{ducker(1, 20, -40, 0.01, 0, 0.1)}, {}};
  Graph g(l);
  const auto y = run_graph(g, {bed, key}, 512);
  for (size_t i = 0; i < y.size(); ++i) CHECK(y[i] == bed[i] + key[i]);
}

// ---------------------------------------------------------------------------
// Graph and session

Layout everything_layout() {
  Layout l;
  l.lanes = {
      // Dialogue: high-pass, de-esser, gate, compressor, lane limiter.
      {eq(MIX_FX_HIGH_PASS, 80, 0, 0.7071), deesser(6500, -28, 4, 6), gate(-50, 20, 0.001, 0.05, 0.1),
       compressor(-24, 3, 0.005, 0.12), limiter(-3, 0.003, 0.05)},
      // Music: EQ (every band kind) and a duck under dialogue.
      {eq(MIX_FX_LOW_SHELF, 120, 3, 0.7071), eq(MIX_FX_PEAKING, 900, -4, 1.2), eq(MIX_FX_HIGH_SHELF, 9000, 2, 0.7071),
       eq(MIX_FX_LOW_PASS, 15000, 0, 0.7071), ducker(0, 9, -38, 0.04, 0.15, 0.4)},
      // Effects lane: nothing but delay compensation.
      {},
  };
  l.master = {eq(MIX_FX_PEAKING, 3000, 1.5, 0.8), compressor(-18, 2, 0.01, 0.2, 6, 2), limiter(-2, 0.004)};
  l.gain_db = 3.5;
  l.final_stage = {limiter(-1, 0.005)};
  return l;
}

std::vector<std::vector<float>> everything_inputs(double seconds) {
  auto dialogue = programme(seconds, 0.6, 21);
  // Pauses, so the gate and the duck both open and close.
  for (size_t i = 0; i < dialogue.size(); ++i) {
    const double t = static_cast<double>(i / 2) / kRate;
    if (std::fmod(t, 1.5) > 1.0) dialogue[i] *= 0.001f;
  }
  return {dialogue, programme(seconds, 0.7, 22), programme(seconds, 0.2, 23)};
}

TEST_CASE(bus_graph_output_does_not_depend_on_blocking) {
  const auto inputs = everything_inputs(4.0);
  Graph whole(everything_layout(), MIX_BUS_FLAG_METER);
  std::vector<std::vector<double>> whole_meters;
  const auto ref = run_graph(whole, inputs, static_cast<int>(inputs[0].size() / 2), &whole_meters);
  for (int block : {128, 1000, 4097}) {
    Graph g(everything_layout(), MIX_BUS_FLAG_METER);
    std::vector<std::vector<double>> meters;
    const auto out = run_graph(g, inputs, block, &meters);
    CHECK(std::memcmp(ref.data(), out.data(), ref.size() * sizeof(float)) == 0);
    // Loudness readings (not the per-read gain-reduction peaks) match too.
    for (int i = MIX_METER_MOMENTARY; i <= MIX_METER_SAMPLE_PEAK; ++i) {
      CHECK(std::memcmp(&whole_meters.back()[i], &meters.back()[i], sizeof(double)) == 0);
    }
  }
}

TEST_CASE(lanes_stay_aligned_through_delay_compensation) {
  // An impulse on every lane, one lane behind a limiter: all three land on the
  // same output frame (the graph's latency), so nothing smears or combs.
  Layout l;
  l.lanes = {{limiter(0, 0.002)}, {}, {}};
  Graph g(l);
  const int latency = bus_graph_latency(g.handle);
  std::vector<float> impulse(static_cast<size_t>(2000) * 2, 0.f);
  impulse[2 * 10] = impulse[2 * 10 + 1] = 0.25f;
  const auto y = run_graph(g, {impulse, impulse, impulse}, 128);
  for (int i = 0; i < 2000; ++i) CHECK(y[2 * i] == (i == 10 + latency ? 0.75f : 0.f));
}

TEST_CASE(retune_keeps_state_or_refuses_structure_changes) {
  Layout l = everything_layout();
  Graph g(l);
  const auto inputs = everything_inputs(1.0);
  run_graph(g, inputs, 512);
  std::vector<double> effects;
  std::vector<int> buses;
  int master_first = 0;
  int final_first = 0;
  // Same structure, new parameters: retuned in place.
  l.lanes[1][1][MIX_FX_GAIN_DB] = -6;
  l.master[1][MIX_FX_THRESHOLD_DB] = -20;
  l.gain_db = 1.0;
  l.pack(&effects, &buses, &master_first, &final_first);
  CHECK(bus_graph_update(g.handle, effects.data(), static_cast<int>(effects.size() / MIX_FX_STRIDE), buses.data(), 3,
                         master_first, 3, l.gain_db, final_first, 1) == CS_OK);
  // A new stage, or a different look-ahead, is a new graph.
  Layout grown = l;
  grown.lanes[2].push_back(compressor(-20, 2, 0.01, 0.1));
  grown.pack(&effects, &buses, &master_first, &final_first);
  CHECK(bus_graph_update(g.handle, effects.data(), static_cast<int>(effects.size() / MIX_FX_STRIDE), buses.data(), 3,
                         master_first, 3, l.gain_db, final_first, 1) == CS_ESTATE);
  Layout slower = l;
  slower.final_stage[0][MIX_FX_ATTACK] = 0.01;
  slower.pack(&effects, &buses, &master_first, &final_first);
  CHECK(bus_graph_update(g.handle, effects.data(), static_cast<int>(effects.size() / MIX_FX_STRIDE), buses.data(), 3,
                         master_first, 3, l.gain_db, final_first, 1) == CS_ESTATE);
  CHECK(bus_graph_latency(g.handle) == bus_graph_latency(Graph(l).handle));
}

/** Clip PCM placed on lanes, mixed through a bus session in `chunk`-frame calls. */
struct SessionRun {
  std::vector<float> out;
  std::vector<double> meters;
};

SessionRun run_session(const std::vector<std::vector<float>>& lane_pcm, const Layout& l, int chunk, int flags,
                       bool route = true) {
  std::vector<double> effects;
  std::vector<int> buses;
  int master_first = 0;
  int final_first = 0;
  l.pack(&effects, &buses, &master_first, &final_first);
  const int lanes = static_cast<int>(l.lanes.size());
  const int entries = static_cast<int>(lane_pcm.size());
  MixFxSession* s = mix_bus_session_create(kRate, 2, entries, effects.data(),
                                           static_cast<int>(effects.size() / MIX_FX_STRIDE), buses.data(), lanes,
                                           master_first, static_cast<int>(l.master.size()), l.gain_db, final_first,
                                           static_cast<int>(l.final_stage.size()), flags);
  CHECK(s != nullptr);
  SessionRun run;
  const int frames = static_cast<int>(lane_pcm[0].size() / 2);
  run.out.resize(static_cast<size_t>(frames) * 2);
  // Each clip is the whole planar signal (uploaded whole: reads past it are silence).
  std::vector<float> pcm;
  std::vector<int> meta;
  for (int e = 0; e < entries; ++e) {
    meta.insert(meta.end(), {static_cast<int>(pcm.size()), frames, 2, kRate, 0, frames});
    for (int c = 0; c < 2; ++c) {
      for (int i = 0; i < frames; ++i) pcm.push_back(lane_pcm[e][2 * i + c]);
    }
  }
  std::vector<double> rows;
  for (int e = 0; e < entries; ++e) {
    rows.insert(rows.end(), {static_cast<double>(e), 0.0, static_cast<double>(frames) / kRate, 0.0, 1.0, 0.0, 0.0,
                             1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, static_cast<double>(e),
                             route ? static_cast<double>(e) : -1.0});
  }
  for (int begin = 0; begin < frames; begin += chunk) {
    const int n = std::min(chunk, frames - begin);
    CHECK(mix_fx_session_range(s, run.out.data() + static_cast<size_t>(begin) * 2, n, begin, pcm.data(),
                               static_cast<int>(pcm.size()), meta.data(), entries, rows.data(), entries, nullptr, 0,
                               MIX_FLAG_EFFECTS) == 0);
  }
  run.meters.resize(64);
  run.meters.resize(static_cast<size_t>(std::max(0, mix_fx_session_meters(s, run.meters.data(), 64))));
  mix_fx_session_destroy(s);
  return run;
}

TEST_CASE(fx_session_with_every_bus_effect_is_chunk_invariant) {
  const auto inputs = everything_inputs(3.0);
  const int frames = static_cast<int>(inputs[0].size() / 2);
  const SessionRun whole = run_session(inputs, everything_layout(), frames, MIX_BUS_FLAG_METER);
  for (int chunk : {1024, 4096 + 7, 48000}) {
    const SessionRun chunked = run_session(inputs, everything_layout(), chunk, MIX_BUS_FLAG_METER);
    CHECK(std::memcmp(whole.out.data(), chunked.out.data(), whole.out.size() * sizeof(float)) == 0);
    CHECK(chunked.meters.size() == whole.meters.size());
    for (int i = MIX_METER_MOMENTARY; i <= MIX_METER_SAMPLE_PEAK; ++i) {
      CHECK(std::memcmp(&whole.meters[i], &chunked.meters[i], sizeof(double)) == 0);
    }
  }
}

TEST_CASE(session_matches_the_worklet_graph_bit_for_bit) {
  // Preview parity at the bus stage: the standalone graph (what the
  // AudioWorklet runs, fed 128-frame quanta of the same lane signals) equals
  // the export session's output once its look-ahead delay is accounted for.
  const auto inputs = everything_inputs(3.0);
  const int frames = static_cast<int>(inputs[0].size() / 2);
  const SessionRun exported = run_session(inputs, everything_layout(), 4096, 0);
  Graph g(everything_layout());
  const int latency = bus_graph_latency(g.handle);
  std::vector<std::vector<float>> padded = inputs;
  for (auto& lane : padded) lane.resize(lane.size() + static_cast<size_t>(latency) * 2, 0.f);
  const auto preview = run_graph(g, padded, 128);
  const size_t shift = static_cast<size_t>(latency) * 2;
  CHECK(std::memcmp(exported.out.data(), preview.data() + shift, static_cast<size_t>(frames) * 2 * sizeof(float)) ==
        0);
}

TEST_CASE(inactive_bus_session_matches_the_legacy_mix_bitwise) {
  // No stage, no duck, 0 dB, with or without the meter: the delivered samples
  // are today's direct mix, so projects without bus settings export unchanged.
  const auto inputs = everything_inputs(1.5);
  const int frames = static_cast<int>(inputs[0].size() / 2);
  Layout plain;
  plain.lanes = {{}, {}, {}};
  const SessionRun legacy = run_session(inputs, Layout{}, frames, 0, false);
  for (int flags : {0, static_cast<int>(MIX_BUS_FLAG_METER)}) {
    for (bool route : {false, true}) {
      const SessionRun run = run_session(inputs, plain, 1000, flags, route);
      CHECK(std::memcmp(legacy.out.data(), run.out.data(), legacy.out.size() * sizeof(float)) == 0);
    }
  }
}

TEST_CASE(two_pass_normalization_lands_on_target) {
  // Pass 1 meters the mix; pass 2 applies target - measured and the final
  // true-peak limiter. Streaming targets: within 0.5 LU and <= -1 dBTP.
  const auto inputs = everything_inputs(20.0);
  const int frames = static_cast<int>(inputs[0].size() / 2);
  for (double target : {-14.0, -16.0, -23.0}) {
    Layout l = everything_layout();
    l.final_stage.clear();
    l.gain_db = 0;
    const SessionRun pass1 = run_session(inputs, l, 48000, MIX_BUS_FLAG_METER);
    const double measured = pass1.meters[MIX_METER_INTEGRATED];
    CHECK(std::isfinite(measured));
    l.gain_db = target - measured;
    l.final_stage = {limiter(-1.0)};
    const SessionRun pass2 = run_session(inputs, l, 48000, MIX_BUS_FLAG_METER);
    CHECK_NEAR(pass2.meters[MIX_METER_INTEGRATED], target, 0.5);
    CHECK_LE(true_peak_db(pass2.out), -1.0);
    (void)frames;
  }
}

// ---------------------------------------------------------------------------
// Denormals

TEST_CASE(silence_after_a_tone_stays_out_of_subnormals) {
  // Every recursive path (biquads, envelopes, ramps, meter filters) decays
  // toward zero in silence; without the flushes those tails go subnormal,
  // which WASM (no FTZ / DAZ) and x86 both run many times slower. The output
  // must stay exactly 0 or normal, and the last seconds of silence must cost
  // no more than the first.
  Layout l = everything_layout();
  l.lanes[1].pop_back();  // no duck: the bed keeps playing silence too
  const auto inputs = std::vector<std::vector<float>>{concat({programme(2.0, 0.6, 5), silence(30)}),
                                                       concat({programme(2.0, 0.6, 6), silence(30)}),
                                                       concat({programme(2.0, 0.2, 7), silence(30)})};
  Graph g(l, MIX_BUS_FLAG_METER);
  const int second = kRate;
  const int frames = static_cast<int>(inputs[0].size() / 2);
  std::vector<double> cost;
  std::vector<float> out;
  for (int begin = 0; begin < frames; begin += second) {
    const int n = std::min(second, frames - begin);
    std::vector<float> lanes(static_cast<size_t>(4) * n * 2, 0.f);
    for (int k = 0; k < 3; ++k) {
      std::copy_n(inputs[k].begin() + static_cast<size_t>(begin) * 2, static_cast<size_t>(n) * 2,
                  lanes.begin() + static_cast<size_t>(k) * n * 2);
    }
    std::vector<float> y(static_cast<size_t>(n) * 2);
    const auto t0 = std::chrono::steady_clock::now();
    bus_graph_process(g.handle, lanes.data(), y.data(), n);
    cost.push_back(std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
    out.insert(out.end(), y.begin(), y.end());
  }
  for (size_t i = static_cast<size_t>(2.5 * kRate) * 2; i < out.size(); ++i) {
    CHECK(std::fpclassify(out[i]) != FP_SUBNORMAL);
  }
  // Seconds 3..5 (early silence) vs the last 3 seconds; take the minimum of
  // each window so scheduler noise cannot fail the test, only a sustained
  // slowdown can.
  const double early = *std::min_element(cost.begin() + 3, cost.begin() + 6);
  const double late = *std::min_element(cost.end() - 3, cost.end());
  CHECK_LE(late, early * 2.0);
}

TEST_CASE(api_rejects_malformed_layouts) {
  std::vector<double> effects = limiter(-1.0);
  const int bad_bus[] = {0, 2};  // range past the blob
  CHECK(bus_graph_create(kRate, 2, effects.data(), 1, bad_bus, 1, 0, 0, 0, 0, 0, 0) == nullptr);
  CHECK(bus_graph_create(kRate, 3, effects.data(), 1, nullptr, 0, 0, 0, 0, 0, 0, 0) == nullptr);
  CHECK(bus_graph_create(kRate, 2, effects.data(), 1, nullptr, 0, 0, 2, 0, 0, 0, 0) == nullptr);
  CHECK(bus_graph_create(kRate, 2, effects.data(), 1, nullptr, 0, 0, 0, std::nan(""), 0, 0, 0) == nullptr);
  CHECK(bus_graph_create(kRate, 2, effects.data(), 1, nullptr, MIX_BUS_MAX_LANES + 1, 0, 0, 0, 0, 0, 0) == nullptr);
  CHECK(mix_bus_session_create(kRate, 2, 0, effects.data(), 1, bad_bus, 1, 0, 0, 0, 0, 0, 0) == nullptr);
  CHECK(loudness_meter_create(kRate, 6) == nullptr);
  CHECK(bus_graph_process(nullptr, nullptr, nullptr, 0) == CS_EINVAL);
  CHECK(mix_fx_session_meters(nullptr, nullptr, 0) == CS_EINVAL);
}

}  // namespace
