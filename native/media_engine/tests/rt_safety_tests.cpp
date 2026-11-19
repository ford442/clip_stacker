// Real-time safety of the bus graph the preview's AudioWorklet runs: no heap
// allocation (so, in WASM, no `memory.grow`) inside `bus_graph_process`
// (and `_process_taps`), `bus_graph_update`, `bus_graph_meters`,
// `bus_graph_reset` or `loudness_meter_process` / `_read`, nor in a warmed-up
// export session's `mix_bus_session_range`. This binary replaces the global
// operator new / delete with counting versions, which is why it is its own
// executable.
//
//   rt_safety_tests --list

#include "audio_mix.h"
#include "host_test.h"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <new>
#include <vector>

namespace {

std::atomic<long long> g_allocations{0};
std::atomic<bool> g_counting{false};

void* counted(std::size_t n) {
  if (g_counting.load(std::memory_order_relaxed)) g_allocations.fetch_add(1, std::memory_order_relaxed);
  return std::malloc(n == 0 ? 1 : n);
}

void* counted_aligned(std::size_t n, std::size_t align) {
  if (g_counting.load(std::memory_order_relaxed)) g_allocations.fetch_add(1, std::memory_order_relaxed);
  const std::size_t rounded = (n + align - 1) / align * align;
  return std::aligned_alloc(align, rounded == 0 ? align : rounded);
}

}  // namespace

void* operator new(std::size_t n) {
  void* p = counted(n);
  if (!p) throw std::bad_alloc();
  return p;
}
void* operator new[](std::size_t n) {
  void* p = counted(n);
  if (!p) throw std::bad_alloc();
  return p;
}
void* operator new(std::size_t n, const std::nothrow_t&) noexcept { return counted(n); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { return counted(n); }
void* operator new(std::size_t n, std::align_val_t a) {
  void* p = counted_aligned(n, static_cast<std::size_t>(a));
  if (!p) throw std::bad_alloc();
  return p;
}
void* operator new[](std::size_t n, std::align_val_t a) {
  void* p = counted_aligned(n, static_cast<std::size_t>(a));
  if (!p) throw std::bad_alloc();
  return p;
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }
void operator delete(void* p, std::align_val_t) noexcept { std::free(p); }
void operator delete[](void* p, std::align_val_t) noexcept { std::free(p); }
void operator delete(void* p, std::size_t, std::align_val_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t, std::align_val_t) noexcept { std::free(p); }

namespace {

constexpr int kRate = 48000;
constexpr int kQuantum = 128;  // one Web Audio render quantum
constexpr double kPi = 3.14159265358979323846;

/** Allocations made by `fn` (the counting window covers nothing else). */
template <typename Fn>
long long allocations_in(Fn&& fn) {
  g_allocations.store(0);
  g_counting.store(true);
  fn();
  g_counting.store(false);
  return g_allocations.load();
}

std::vector<double> fx_row(int kind, std::initializer_list<std::pair<int, double>> fields) {
  std::vector<double> r(MIX_FX_STRIDE, 0.0);
  r[MIX_FX_KIND] = kind;
  r[MIX_FX_ENABLED] = 1;
  for (const auto& f : fields) r[f.first] = f.second;
  return r;
}

/** Every bus stage kind: two lanes (one ducked under the other), master chain, final limiter. */
struct Packed {
  std::vector<double> effects;
  std::vector<int> buses;
  int master_first = 0;
  int master_count = 0;
  int final_first = 0;
  int final_count = 0;

  explicit Packed(double comp_threshold) {
    auto add = [&](const std::vector<double>& r) { effects.insert(effects.end(), r.begin(), r.end()); };
    // Lane 0 (dialogue): HPF, de-esser, gate, compressor, limiter.
    add(fx_row(MIX_FX_HIGH_PASS, {{MIX_FX_FREQ, 80}, {MIX_FX_Q, 0.7071}}));
    add(fx_row(MIX_FX_DEESSER, {{MIX_FX_FREQ, 6500}, {MIX_FX_THRESHOLD_DB, -28}, {MIX_FX_RATIO, 4},
                                {MIX_FX_RANGE_DB, 6}, {MIX_FX_ATTACK, 0.001}, {MIX_FX_RELEASE, 0.05}}));
    add(fx_row(MIX_FX_GATE, {{MIX_FX_THRESHOLD_DB, -50}, {MIX_FX_RANGE_DB, 20}, {MIX_FX_ATTACK, 0.001},
                             {MIX_FX_HOLD, 0.05}, {MIX_FX_RELEASE, 0.1}}));
    add(fx_row(MIX_FX_COMPRESSOR, {{MIX_FX_THRESHOLD_DB, comp_threshold}, {MIX_FX_RATIO, 3}, {MIX_FX_KNEE_DB, 6},
                                   {MIX_FX_ATTACK, 0.005}, {MIX_FX_RELEASE, 0.12}}));
    add(fx_row(MIX_FX_LIMITER, {{MIX_FX_THRESHOLD_DB, -3}, {MIX_FX_ATTACK, 0.003}, {MIX_FX_RELEASE, 0.05}}));
    // Lane 1 (music): EQ and a duck under lane 0.
    add(fx_row(MIX_FX_PEAKING, {{MIX_FX_FREQ, 900}, {MIX_FX_GAIN_DB, -4}, {MIX_FX_Q, 1.2}}));
    add(fx_row(MIX_FX_DUCKER, {{MIX_FX_KEY, 0}, {MIX_FX_RANGE_DB, 9}, {MIX_FX_THRESHOLD_DB, -38},
                               {MIX_FX_ATTACK, 0.04}, {MIX_FX_HOLD, 0.15}, {MIX_FX_RELEASE, 0.4}}));
    buses = {0, 5, 0, 5, 2, 0};
    // Master: compressor + limiter; final: limiter.
    master_first = 7;
    add(fx_row(MIX_FX_COMPRESSOR, {{MIX_FX_THRESHOLD_DB, -18}, {MIX_FX_RATIO, 2}, {MIX_FX_KNEE_DB, 6},
                                   {MIX_FX_ATTACK, 0.01}, {MIX_FX_RELEASE, 0.2}}));
    add(fx_row(MIX_FX_LIMITER, {{MIX_FX_THRESHOLD_DB, -2}, {MIX_FX_ATTACK, 0.004}, {MIX_FX_RELEASE, 0.1}}));
    master_count = 2;
    final_first = 9;
    add(fx_row(MIX_FX_LIMITER, {{MIX_FX_THRESHOLD_DB, -1}, {MIX_FX_ATTACK, 0.005}, {MIX_FX_RELEASE, 0.1}}));
    final_count = 1;
  }
  int effect_count() const { return static_cast<int>(effects.size() / MIX_FX_STRIDE); }
};

/** One quantum of three input blocks (two lanes + direct), interleaved stereo. */
void fill_quantum(std::vector<float>* lanes, long long frame0) {
  for (int l = 0; l < 3; ++l) {
    for (int i = 0; i < kQuantum; ++i) {
      const double t = static_cast<double>(frame0 + i) / kRate;
      const double burst = std::fmod(t, 0.7) < 0.3 ? 0.8 : 0.01;
      const double v = burst * std::sin(2 * kPi * (220.0 + 330.0 * l) * t) + 0.2 * std::sin(2 * kPi * 7000.0 * t);
      (*lanes)[static_cast<size_t>(l) * kQuantum * 2 + 2 * i] = static_cast<float>(v);
      (*lanes)[static_cast<size_t>(l) * kQuantum * 2 + 2 * i + 1] = static_cast<float>(v);
    }
  }
}

}  // namespace

TEST_CASE(counting_hook_sees_allocations) {
  // Positive control: the hook is live in this binary.
  const long long n = allocations_in([] {
    std::vector<int>* v = new std::vector<int>(100);
    delete v;
  });
  CHECK(n >= 2);
}

TEST_CASE(bus_graph_process_update_meters_and_reset_never_allocate) {
  const Packed layout(-24.0);
  const Packed retuned(-30.0);  // same structure, new compressor threshold
  BusGraphHandle* g = bus_graph_create(kRate, 2, layout.effects.data(), layout.effect_count(), layout.buses.data(), 2,
                                       layout.master_first, layout.master_count, 0.0, layout.final_first,
                                       layout.final_count, MIX_BUS_FLAG_METER);
  CHECK(g != nullptr);
  if (!g) return;
  std::vector<float> lanes(static_cast<size_t>(3) * kQuantum * 2);
  std::vector<float> out(static_cast<size_t>(kQuantum) * 2);
  double meters[64];
  long long frame = 0;
  int update_failures = 0;
  // 20 s of quanta: the meter closes 200 sub-blocks, 197 gating blocks and
  // 171 short-term blocks (it used to grow vectors for all of them), retunes
  // run every ~50 ms as a slider drag would, and the meters are read every
  // ~100 ms, which used to run the O(N) integrated pass and a sort-merge.
  const long long n = allocations_in([&] {
    for (int q = 0; q < 20 * kRate / kQuantum; ++q, frame += kQuantum) {
      fill_quantum(&lanes, frame);
      bus_graph_process(g, lanes.data(), out.data(), kQuantum);
      if (q % 19 == 0) {
        const Packed& p = (q / 19) % 2 ? retuned : layout;
        update_failures += bus_graph_update(g, p.effects.data(), p.effect_count(), p.buses.data(), 2, p.master_first,
                                            p.master_count, -0.5 * (q % 3), p.final_first, p.final_count) != CS_OK;
      }
      if (q % 37 == 0) bus_graph_meters(g, meters, 64);
      if (q == 3000) bus_graph_reset(g);
      if (q == 5000) bus_graph_reset_meter(g);
    }
  });
  CHECK(n == 0);
  CHECK(update_failures == 0);
  CHECK(bus_graph_meters(g, meters, 64) > MIX_METER_LANE_GR);
  CHECK(std::isfinite(meters[MIX_METER_INTEGRATED]));
  for (float v : out) CHECK(std::isfinite(v));

  // A structure change is refused without allocating either.
  Packed grown(-24.0);
  grown.effects[3 * MIX_FX_STRIDE + MIX_FX_ENABLED] = 0;  // drop lane 0's compressor
  const long long refused = allocations_in([&] {
    CHECK(bus_graph_update(g, grown.effects.data(), grown.effect_count(), grown.buses.data(), 2, grown.master_first,
                           grown.master_count, 0.0, grown.final_first, grown.final_count) == CS_ESTATE);
  });
  CHECK(refused == 0);
  bus_graph_destroy(g);
}

TEST_CASE(loudness_meter_never_allocates_after_create) {
  LoudnessMeterHandle* m = loudness_meter_create(kRate, 2);
  CHECK(m != nullptr);
  if (!m) return;
  std::vector<float> block(static_cast<size_t>(kRate) * 2);
  for (int i = 0; i < kRate; ++i) block[2 * i] = block[2 * i + 1] = static_cast<float>(0.3 * std::sin(i * 0.05));
  double reading[6];
  const long long n = allocations_in([&] {
    for (int s = 0; s < 40; ++s) {  // 40 s
      CHECK(loudness_meter_process(m, block.data(), kRate) == CS_OK);
      CHECK(loudness_meter_read(m, reading, 6) == 6);
    }
  });
  CHECK(n == 0);
  CHECK(std::isfinite(reading[MIX_METER_INTEGRATED]));
  loudness_meter_destroy(m);
}

namespace {

/** `Packed` with both lanes tapped (the taps' delay lines are sized in build, never in process). */
Packed tapped_layout(double comp_threshold) {
  Packed p(comp_threshold);
  p.buses[MIX_BUS_FLAGS] = MIX_BUS_TAP;
  p.buses[MIX_BUS_STRIDE + MIX_BUS_FLAGS] = MIX_BUS_TAP;
  return p;
}

constexpr int kTapFlags = MIX_BUS_FLAG_METER | MIX_BUS_FLAG_TAP_DIRECT;

}  // namespace

TEST_CASE(bus_graph_process_taps_never_allocates) {
  const Packed layout = tapped_layout(-24.0);
  const Packed retuned = tapped_layout(-30.0);
  BusGraphHandle* g = bus_graph_create(kRate, 2, layout.effects.data(), layout.effect_count(), layout.buses.data(), 2,
                                       layout.master_first, layout.master_count, 0.0, layout.final_first,
                                       layout.final_count, kTapFlags);
  CHECK(g != nullptr);
  if (!g) return;
  CHECK(bus_graph_tap_count(g) == 3);  // both lanes, then direct
  std::vector<float> lanes(static_cast<size_t>(3) * kQuantum * 2);
  std::vector<float> out(static_cast<size_t>(kQuantum) * 2);
  std::vector<float> taps(static_cast<size_t>(3) * kQuantum * 2);
  double meters[64];
  long long frame = 0;
  int failures = 0;
  const long long n = allocations_in([&] {
    for (int q = 0; q < 10 * kRate / kQuantum; ++q, frame += kQuantum) {
      fill_quantum(&lanes, frame);
      failures += bus_graph_process_taps(g, lanes.data(), out.data(), taps.data(), kQuantum) != CS_OK;
      if (q % 19 == 0) {
        const Packed& p = (q / 19) % 2 ? retuned : layout;
        failures += bus_graph_update(g, p.effects.data(), p.effect_count(), p.buses.data(), 2, p.master_first,
                                     p.master_count, 0.0, p.final_first, p.final_count) != CS_OK;
      }
      if (q % 37 == 0) bus_graph_meters(g, meters, 64);
      if (q == 1500) bus_graph_reset(g);
    }
  });
  CHECK(n == 0);
  CHECK(failures == 0);
  for (float v : taps) CHECK(std::isfinite(v));
  bus_graph_destroy(g);
}

TEST_CASE(warmed_up_bus_session_range_never_allocates) {
  // The export premix calls mix_bus_session_range once per chunk: after the
  // first call has sized the lane, bus and tap buffers (and built the clip
  // insert chains), a fixed chunk size reuses them.
  const Packed layout = tapped_layout(-24.0);
  constexpr int kEntries = 3;  // one clip per lane, one direct
  MixFxSession* s = mix_bus_session_create(kRate, 2, kEntries, layout.effects.data(), layout.effect_count(),
                                           layout.buses.data(), 2, layout.master_first, layout.master_count, 0.0,
                                           layout.final_first, layout.final_count, kTapFlags);
  CHECK(s != nullptr);
  if (!s) return;
  const int taps_n = mix_bus_session_tap_count(s);
  CHECK(taps_n == 3);
  const int clip_frames = 4 * kRate;
  std::vector<float> pcm;
  std::vector<int> meta;
  std::vector<double> rows;
  for (int e = 0; e < kEntries; ++e) {
    // The third clip is 44.1 kHz, so the polyphase resampler runs too.
    const int rate = e == 2 ? 44100 : kRate;
    meta.insert(meta.end(), {static_cast<int>(pcm.size()), clip_frames, 2, rate, 0, clip_frames});
    for (int c = 0; c < 2; ++c) {
      for (int i = 0; i < clip_frames; ++i) {
        pcm.push_back(static_cast<float>(0.3 * std::sin(2 * kPi * (200.0 + 150.0 * e + c) * i / rate)));
      }
    }
    // Clip 0 carries an insert EQ (lane 1's peaking row); it routes to lane e, the last clip direct.
    rows.insert(rows.end(), {static_cast<double>(e), 0.0, 4.0, 0.0, 0.8, 0.01, 0.01, 1.0, 0.0, 0.0, 0.0, 0.0,
                             e == 0 ? 5.0 : 0.0, e == 0 ? 1.0 : 0.0, static_cast<double>(e), e < 2 ? e : -1.0});
  }
  constexpr int kChunk = 4800;
  std::vector<float> out(static_cast<size_t>(kChunk) * 2);
  std::vector<float> taps(static_cast<size_t>(taps_n) * kChunk * 2);
  double meters[64];
  auto range = [&](int chunk) {
    return mix_bus_session_range(s, out.data(), taps.data(), kChunk, static_cast<double>(chunk) * kChunk, pcm.data(),
                                 static_cast<int>(pcm.size()), meta.data(), kEntries, rows.data(), kEntries, nullptr, 0,
                                 MIX_FLAG_EFFECTS);
  };
  CHECK(range(0) == CS_OK);  // warm-up
  int failures = 0;
  const long long n = allocations_in([&] {
    for (int chunk = 1; chunk < 50; ++chunk) {
      failures += range(chunk) != CS_OK;
      if (chunk % 10 == 0) mix_fx_session_meters(s, meters, 64);
    }
  });
  CHECK(n == 0);
  CHECK(failures == 0);
  for (float v : taps) CHECK(std::isfinite(v));
  mix_fx_session_destroy(s);
}
