// Property tests for the bus / insert effect rows: seeded random
// `MIX_FX_STRIDE` rows (in range, out of range, NaN, inf, unknown kinds) and
// seeded random signals (silence, tones up to +12 dBFS, full-scale squares,
// impulses, DC, noise, non-finite samples), checked for properties that must
// hold for any input:
//
//   - every output sample is finite;
//   - the peak is bounded by what the structure allows (EQ gain, make-up,
//     output gain), and a final limiter's ceiling is never exceeded;
//   - no output sample is subnormal (the inter-stage flush), so a tail
//     cannot crawl through subnormal arithmetic;
//   - output and meter readings do not depend on how the audio is blocked;
//   - retuning with fresh random parameters (same structure) keeps all of it.
//
// The NaN compressor of #344 B1 (hard knee at a 0 dB threshold fed full
// scale) fails the first property within the first few seeds.
//
//   fx_property_tests --list
//   FX_PROPERTY_SEEDS=5000 fx_property_tests --long   # a longer soak

#include "audio_mix.h"
#include "effects.h"
#include "host_test.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

namespace {

constexpr int kRate = 48000;
constexpr double kPi = 3.14159265358979323846;

/** SplitMix64: a seed fully determines a case, so a failure prints the seed to rerun. */
struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ull + 1) {}
  uint64_t next() {
    uint64_t z = (s += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
  }
  double unit() { return static_cast<double>(next() >> 11) * (1.0 / 9007199254740992.0); }
  double range(double lo, double hi) { return lo + (hi - lo) * unit(); }
  int below(int n) { return static_cast<int>(next() % static_cast<uint64_t>(n)); }
  bool chance(double p) { return unit() < p; }
};

/** A field value: usually plausible, sometimes far out of range or non-finite. */
double field(Rng& r, double lo, double hi) {
  const int roll = r.below(40);
  if (roll == 0) return std::numeric_limits<double>::quiet_NaN();
  if (roll == 1) return std::numeric_limits<double>::infinity();
  if (roll == 2) return -std::numeric_limits<double>::infinity();
  if (roll == 3) return r.range(-1e9, 1e9);
  if (roll == 4) return lo;
  if (roll == 5) return hi;
  return r.range(lo, hi);
}

std::vector<double> random_row(Rng& r, int lanes_before) {
  std::vector<double> row(MIX_FX_STRIDE, 0.0);
  row[MIX_FX_KIND] = r.below(12);  // 0 and 11 are unknown kinds
  row[MIX_FX_ENABLED] = r.chance(0.85) ? 1 : 0;
  row[MIX_FX_FREQ] = field(r, 10, 24000);
  row[MIX_FX_GAIN_DB] = field(r, -24, 24);
  row[MIX_FX_Q] = field(r, 0.1, 30);
  row[MIX_FX_THRESHOLD_DB] = field(r, -100, 0);
  row[MIX_FX_RATIO] = field(r, 1, 20);
  row[MIX_FX_ATTACK] = field(r, 0, 0.1);
  row[MIX_FX_RELEASE] = field(r, 0, 1);
  row[MIX_FX_KNEE_DB] = field(r, 0, 24);
  row[MIX_FX_HOLD] = field(r, 0, 0.5);
  row[MIX_FX_RANGE_DB] = field(r, 0, 100);
  row[MIX_FX_KEY] = r.below(lanes_before + 3) - 2;
  return row;
}

/** Same structure (kind, enabled, limiter look-ahead, duck key), fresh parameters. */
std::vector<double> retuned(Rng& r, const std::vector<double>& row) {
  std::vector<double> next = random_row(r, 0);
  next[MIX_FX_KIND] = row[MIX_FX_KIND];
  next[MIX_FX_ENABLED] = row[MIX_FX_ENABLED];
  next[MIX_FX_KEY] = row[MIX_FX_KEY];
  if (row[MIX_FX_KIND] == MIX_FX_LIMITER) next[MIX_FX_ATTACK] = row[MIX_FX_ATTACK];
  return next;
}

struct Case {
  std::vector<double> effects;
  std::vector<int> buses;
  int lanes = 0;
  int master_first = 0;
  int master_count = 0;
  int final_first = 0;
  int final_count = 0;
  double gain_db = 0;
  int flags = 0;
  int frames = 0;
  /** `lanes + 1` interleaved stereo blocks, lane-major (the last one direct). */
  std::vector<float> input;
  int effect_count() const { return static_cast<int>(effects.size() / MIX_FX_STRIDE); }
  const double* row(int i) const { return effects.data() + static_cast<size_t>(i) * MIX_FX_STRIDE; }
};

void fill_signal(Rng& r, float* out, int frames, bool allow_non_finite) {
  int f = 0;
  while (f < frames) {
    const int len = std::min(frames - f, 1 + r.below(kRate / 4));
    const int kind = r.below(8);
    const double amp = r.chance(0.2) ? r.range(1.0, 4.0) : r.range(1e-6, 1.0);
    const double freq = r.chance(0.2) ? r.range(15000, 23900) : r.range(20, 8000);
    const double phase = r.range(0, 2 * kPi);
    for (int i = 0; i < len; ++i, ++f) {
      for (int c = 0; c < 2; ++c) {
        double v = 0;
        switch (kind) {
          case 0:
            v = 0;
            break;
          case 1:
          case 2:
            v = amp * std::sin(2 * kPi * freq * f / kRate + phase + c);
            break;
          case 3:
            v = ((f / std::max(1, static_cast<int>(kRate / freq))) & 1) ? amp : -amp;
            break;
          case 4:
            v = i == 0 ? amp : 0;
            break;
          case 5:
            v = amp;
            break;
          default:
            v = amp * r.range(-1, 1);
            break;
        }
        out[2 * f + c] = static_cast<float>(v);
      }
    }
  }
  if (allow_non_finite) {
    const int hits = 1 + r.below(4);
    for (int h = 0; h < hits; ++h) {
      const int at = r.below(frames * 2);
      const int which = r.below(3);
      out[at] = which == 0   ? std::numeric_limits<float>::quiet_NaN()
                : which == 1 ? std::numeric_limits<float>::infinity()
                             : -std::numeric_limits<float>::infinity();
    }
  }
}

Case random_case(uint64_t seed, double seconds) {
  Rng r(seed);
  Case k;
  k.lanes = 1 + r.below(4);
  for (int l = 0; l < k.lanes; ++l) {
    const int first = k.effect_count();
    const int n = r.below(9);
    for (int i = 0; i < n; ++i) {
      const auto row = random_row(r, l);
      k.effects.insert(k.effects.end(), row.begin(), row.end());
    }
    k.buses.insert(k.buses.end(), {first, n});
  }
  k.master_first = k.effect_count();
  k.master_count = r.below(5);
  for (int i = 0; i < k.master_count; ++i) {
    const auto row = random_row(r, 0);
    k.effects.insert(k.effects.end(), row.begin(), row.end());
  }
  k.final_first = k.effect_count();
  k.final_count = r.below(3);
  for (int i = 0; i < k.final_count; ++i) {
    auto row = random_row(r, 0);
    if (r.chance(0.7)) row[MIX_FX_KIND] = MIX_FX_LIMITER;
    k.effects.insert(k.effects.end(), row.begin(), row.end());
  }
  if (k.effects.empty()) k.effects.assign(MIX_FX_STRIDE, 0.0);
  k.gain_db = r.chance(0.5) ? 0.0 : r.range(-80, 80);
  k.flags = r.chance(0.5) ? MIX_BUS_FLAG_METER : 0;
  k.frames = static_cast<int>(seconds * kRate);
  const bool non_finite = r.chance(0.1);
  k.input.assign(static_cast<size_t>(k.lanes + 1) * k.frames * 2, 0.f);
  for (int l = 0; l <= k.lanes; ++l) {
    if (l == k.lanes && r.chance(0.5)) continue;  // direct input often silent
    fill_signal(r, k.input.data() + static_cast<size_t>(l) * k.frames * 2, k.frames, non_finite);
  }
  // A silent second at the end: tails ring out (and must not go subnormal).
  for (int l = 0; l <= k.lanes; ++l) {
    float* lane = k.input.data() + static_cast<size_t>(l) * k.frames * 2;
    std::fill(lane + static_cast<size_t>(k.frames - kRate) * 2, lane + static_cast<size_t>(k.frames) * 2, 0.f);
  }
  return k;
}

bool enabled(const double* row, int kind) {
  return row[MIX_FX_ENABLED] != 0.0 && row[MIX_FX_KIND] == kind;
}

bool is_eq(double kind) {
  return kind == MIX_FX_PEAKING || kind == MIX_FX_LOW_SHELF || kind == MIX_FX_HIGH_SHELF || kind == MIX_FX_HIGH_PASS ||
         kind == MIX_FX_LOW_PASS;
}

/**
 * Peak a chain can deliver for an input peak `peak`: each EQ section at most
 * x300 (+24 dB with a Q-30 resonance and its transient overshoot), a
 * compressor at most its make-up (<= +24 dB), a de-esser's moving shelf x2,
 * gates and ducks <= 1, and a limiter's output clamp resets the bound to its
 * ceiling (<= 0 dBFS).
 */
double chain_bound(const Case& k, int first, int count, double peak) {
  int stages = 0;
  for (int i = 0; i < count; ++i) {
    const double* row = k.row(first + i);
    if (row[MIX_FX_ENABLED] == 0.0) continue;
    const double kind = row[MIX_FX_KIND];
    if (is_eq(kind)) {
      peak *= 300.0;
    } else if (kind == MIX_FX_COMPRESSOR) {
      peak *= 15.9;
    } else if (kind == MIX_FX_DEESSER) {
      peak *= 2.0;
    } else if (kind == MIX_FX_LIMITER) {
      peak = std::min(peak, 1.0);
    } else {
      continue;
    }
    if (++stages >= MIX_BUS_MAX_STAGES) break;
  }
  return peak;
}

double finite_peak(const float* x, size_t n) {
  double peak = 0;
  for (size_t i = 0; i < n; ++i) {
    if (std::isfinite(x[i])) peak = std::max(peak, static_cast<double>(std::fabs(x[i])));
  }
  return peak;
}

struct Run {
  BusGraphHandle* graph = nullptr;
  std::vector<float> out;
  std::vector<double> meters;
};

/** Process the case in blocks drawn from `block_rng` (or fixed `block` frames); retune mid-way when asked. */
bool run_case(const Case& k, int block, uint64_t block_seed, bool retune, Run* run) {
  run->graph = bus_graph_create(kRate, 2, k.effects.data(), k.effect_count(), k.buses.data(), k.lanes, k.master_first,
                                k.master_count, k.gain_db, k.final_first, k.final_count, k.flags);
  if (!run->graph) return false;
  run->out.assign(static_cast<size_t>(k.frames) * 2, 0.f);
  Rng blocks(block_seed);
  Rng tune(block_seed ^ 0xABCDEF);
  Case next = k;
  std::vector<float> lanes;
  for (int begin = 0; begin < k.frames;) {
    const int n = std::min(k.frames - begin, block > 0 ? block : 1 + blocks.below(3000));
    lanes.assign(static_cast<size_t>(k.lanes + 1) * n * 2, 0.f);
    for (int l = 0; l <= k.lanes; ++l) {
      std::copy_n(k.input.data() + (static_cast<size_t>(l) * k.frames + begin) * 2, static_cast<size_t>(n) * 2,
                  lanes.data() + static_cast<size_t>(l) * n * 2);
    }
    CHECK(bus_graph_process(run->graph, lanes.data(), run->out.data() + static_cast<size_t>(begin) * 2, n) == CS_OK);
    if (retune && begin < k.frames / 2 && begin + n >= k.frames / 2) {
      for (int i = 0; i < k.effect_count(); ++i) {
        const auto row = retuned(tune, std::vector<double>(k.row(i), k.row(i) + MIX_FX_STRIDE));
        std::copy(row.begin(), row.end(), next.effects.begin() + static_cast<size_t>(i) * MIX_FX_STRIDE);
      }
      const int rc = bus_graph_update(run->graph, next.effects.data(), next.effect_count(), next.buses.data(),
                                      next.lanes, next.master_first, next.master_count, k.gain_db, next.final_first,
                                      next.final_count);
      CHECK(rc == CS_OK);
    }
    begin += n;
  }
  run->meters.assign(64, 0.0);
  run->meters.resize(static_cast<size_t>(std::max(0, bus_graph_meters(run->graph, run->meters.data(), 64))));
  return true;
}

/** Check every property for one seed; false (with the seed printed) on the first failure. */
bool check_seed(uint64_t seed, double seconds) {
  const Case k = random_case(seed, seconds);
  const int before = host_test::g_failures;
  Run whole;
  if (!run_case(k, k.frames, seed, false, &whole)) {
    // Only a non-finite output gain may be refused; every row is clamped.
    CHECK(!std::isfinite(k.gain_db));
    return host_test::g_failures == before;
  }

  // Structural bound on the output peak.
  double sum_bound = 0;
  for (int l = 0; l <= k.lanes; ++l) {
    const double in = finite_peak(k.input.data() + static_cast<size_t>(l) * k.frames * 2,
                                  static_cast<size_t>(k.frames) * 2);
    sum_bound += l < k.lanes ? chain_bound(k, k.buses[2 * l], k.buses[2 * l + 1], in) : in;
  }
  double bound = chain_bound(k, k.master_first, k.master_count, sum_bound);
  bound *= std::pow(10.0, std::max(-60.0, std::min(60.0, k.gain_db)) / 20.0);
  bound = chain_bound(k, k.final_first, k.final_count, bound);
  double final_ceiling = 1e300;
  for (int i = 0; i < k.final_count; ++i) {
    const double* row = k.row(k.final_first + i);
    if (enabled(row, MIX_FX_LIMITER)) {
      const double c = std::isfinite(row[MIX_FX_THRESHOLD_DB]) ? std::max(-24.0, std::min(0.0, row[MIX_FX_THRESHOLD_DB]))
                                                               : -1.0;
      final_ceiling = std::min(final_ceiling, std::pow(10.0, c / 20.0));
    }
  }

  double peak = 0;
  bool finite = true;
  bool normal = true;
  for (float v : whole.out) {
    finite = finite && std::isfinite(v);
    normal = normal && std::fpclassify(v) != FP_SUBNORMAL;
    if (std::isfinite(v)) peak = std::max(peak, static_cast<double>(std::fabs(v)));
  }
  CHECK(finite);
  CHECK(normal);
  CHECK_LE(peak, bound * 1.0001 + 1e-30);
  if (final_ceiling < 1e300) CHECK_LE(peak, final_ceiling * (1.0 + 1e-6));
  for (double m : whole.meters) CHECK(!std::isnan(m));

  // Blocking does not matter: 128-frame quanta and random blocks give the same bits.
  Run quanta;
  Run random_blocks;
  CHECK(run_case(k, 128, seed, false, &quanta));
  CHECK(run_case(k, 0, seed * 7 + 3, false, &random_blocks));
  CHECK(quanta.out.size() == whole.out.size() &&
        std::memcmp(quanta.out.data(), whole.out.data(), whole.out.size() * sizeof(float)) == 0);
  CHECK(random_blocks.out.size() == whole.out.size() &&
        std::memcmp(random_blocks.out.data(), whole.out.data(), whole.out.size() * sizeof(float)) == 0);
  for (size_t i = 0; i < std::min<size_t>(whole.meters.size(), MIX_METER_SAMPLE_PEAK + 1); ++i) {
    CHECK(std::memcmp(&whole.meters[i], &quanta.meters[i], sizeof(double)) == 0);
  }

  // Retuned half-way with fresh parameters: still finite, still normal.
  Run tuned;
  CHECK(run_case(k, 256, seed, true, &tuned));
  for (float v : tuned.out) {
    if (!std::isfinite(v) || std::fpclassify(v) == FP_SUBNORMAL) {
      CHECK(std::isfinite(v) && std::fpclassify(v) != FP_SUBNORMAL);
      break;
    }
  }

  for (Run* r : {&whole, &quanta, &random_blocks, &tuned}) bus_graph_destroy(r->graph);
  const bool ok = host_test::g_failures == before;
  if (!ok) std::fprintf(stderr, "    failing seed: %llu\n", static_cast<unsigned long long>(seed));
  return ok;
}

/** Insert chains (clip inserts): random rows through `insert_chain_*`, any block size. */
bool check_insert_seed(uint64_t seed) {
  Rng r(seed);
  std::vector<double> rows;
  const int n = r.below(7);
  for (int i = 0; i < n; ++i) {
    const auto row = random_row(r, 0);
    rows.insert(rows.end(), row.begin(), row.end());
  }
  const double rate = r.chance(0.3) ? r.range(8000, 192000) : 48000;
  MixInsertChain* chain = insert_chain_create(rate, rows.empty() ? nullptr : rows.data(), n);
  CHECK(chain != nullptr);
  if (!chain) return false;
  const int frames = kRate;
  std::vector<float> interleaved(static_cast<size_t>(frames) * 2);
  fill_signal(r, interleaved.data(), frames, r.chance(0.1));
  std::vector<float> planar(static_cast<size_t>(frames) * 2);
  for (int i = 0; i < frames; ++i) {
    planar[i] = interleaved[2 * i];
    planar[frames + i] = interleaved[2 * i + 1];
  }
  double in_peak = finite_peak(interleaved.data(), interleaved.size());
  // Insert chains: <= 4 EQ bands then one compressor.
  int bands = 0;
  bool comp = false;
  for (int i = 0; i < n; ++i) {
    const double* row = rows.data() + static_cast<size_t>(i) * MIX_FX_STRIDE;
    if (row[MIX_FX_ENABLED] == 0.0) continue;
    if (is_eq(row[MIX_FX_KIND]) && bands < MIX_FX_MAX_EQ_BANDS) ++bands;
    if (row[MIX_FX_KIND] == MIX_FX_COMPRESSOR) comp = true;
  }
  const double bound = in_peak * std::pow(300.0, bands) * (comp ? 15.9 : 1.0);
  const std::vector<float> original = planar;
  // Random block sizes: the chain carries its state across calls.
  for (int begin = 0; begin < frames;) {
    const int len = std::min(frames - begin, 1 + r.below(2000));
    std::vector<float> block(static_cast<size_t>(len) * 2);
    std::copy_n(planar.begin() + begin, len, block.begin());
    std::copy_n(planar.begin() + frames + begin, len, block.begin() + len);
    CHECK(insert_chain_process(chain, block.data(), len, 2) == CS_OK);
    std::copy_n(block.begin(), len, planar.begin() + begin);
    std::copy_n(block.begin() + len, len, planar.begin() + frames + begin);
    begin += len;
  }
  const int before = host_test::g_failures;
  if (bands == 0 && !comp) {
    // No stage: the chain is not run at all (the mix skips it), so its
    // output is its input bit for bit, non-finite samples included.
    CHECK(std::memcmp(original.data(), planar.data(), planar.size() * sizeof(float)) == 0);
    insert_chain_destroy(chain);
    return host_test::g_failures == before;
  }
  for (float v : planar) {
    if (!std::isfinite(v) || std::fpclassify(v) == FP_SUBNORMAL || std::fabs(v) > bound * 1.0001 + 1e-30) {
      CHECK(std::isfinite(v));
      CHECK(std::fpclassify(v) != FP_SUBNORMAL);
      CHECK_LE(std::fabs(v), bound * 1.0001 + 1e-30);
      break;
    }
  }
  insert_chain_destroy(chain);
  const bool ok = host_test::g_failures == before;
  if (!ok) std::fprintf(stderr, "    failing insert seed: %llu\n", static_cast<unsigned long long>(seed));
  return ok;
}

int seeds_from_env(int fallback) {
  const char* env = std::getenv("FX_PROPERTY_SEEDS");
  const int n = env ? std::atoi(env) : 0;
  return n > 0 ? n : fallback;
}

}  // namespace

TEST_CASE(random_bus_layouts_hold_their_properties) {
  // The PR subset: a couple of dozen short cases (the soak below is nightly).
  for (uint64_t seed = 1; seed <= 24; ++seed) {
    if (!check_seed(seed, 1.2)) break;
  }
}

TEST_CASE(random_insert_chains_hold_their_properties) {
  for (uint64_t seed = 1; seed <= 200; ++seed) {
    if (!check_insert_seed(seed)) break;
  }
}

LONG_TEST_CASE(random_bus_layouts_soak) {
  const int seeds = seeds_from_env(400);
  for (uint64_t seed = 1000; seed < 1000 + static_cast<uint64_t>(seeds); ++seed) {
    if (!check_seed(seed, 3.0)) break;
  }
}

LONG_TEST_CASE(random_insert_chains_soak) {
  const int seeds = seeds_from_env(2000);
  for (uint64_t seed = 100000; seed < 100000 + static_cast<uint64_t>(seeds); ++seed) {
    if (!check_insert_seed(seed)) break;
  }
}
