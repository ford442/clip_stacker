// The allocator is not load-bearing: the shipped WASM builds run the same bus
// sources over two allocators (media_engine: dlmalloc; media_engine_fx, the
// AudioWorklet: emmalloc), and preview / export parity assumes they produce
// the same samples. What differs between two allocators is only *where*
// blocks land and *what bytes* a block holds before it is written (fresh
// pages are zero, a reused block keeps its last owner's data). Output can
// depend on the allocator only through one of those: a read of memory never
// written, or arithmetic on addresses.
//
// Linking emmalloc or dlmalloc into a host binary would not test that (ASan
// owns malloc here, and their host placement says nothing about wasm32's), so
// this binary replaces the global operator new / delete with one that can, at
// run time, (a) defer to the system allocator, or (b) fill every new block
// with a poison byte (0xFF reads as a NaN float / double, 0x7F as a huge
// finite one, 0xA5 as noise) and move it by a different multiple of 16 bytes
// (keeping alignof(max_align_t)), refilling freed blocks too. The all-FX bus
// golden (every bus effect, a duck, master chain, output gain, final
// limiter, meter) runs through the worklet's graph and the export's session
// under each mode, and every run must match the system allocator's bit for
// bit. Every heap allocation in the media engine goes through operator new
// (cs::Buffer, std::vector, nothrow new), so the poison reaches all of them.
//
// It is its own executable because it replaces the global allocation
// functions (as rt_safety_tests does).

#include "audio_mix.h"
#include "host_test.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <new>
#include <utility>
#include <vector>

namespace {

struct AllocMode {
  bool poison = false;
  unsigned char fill = 0;
  /** Extra bytes in front of the block (a multiple of 16). */
  std::size_t shift = 0;
};

AllocMode g_mode;

// Every block carries a 16-byte header just below the pointer handed out:
// the malloc'd base and the requested size, so delete frees (and poisons)
// correctly whichever mode allocated it.
constexpr std::size_t kHeader = 16;

void* allocate(std::size_t n, std::size_t align) {
  if (n == 0) n = 1;
  if (align < kHeader) align = kHeader;
  const AllocMode mode = g_mode;
  unsigned char* base = static_cast<unsigned char*>(std::malloc(kHeader + mode.shift + align + n));
  if (!base) return nullptr;
  std::uintptr_t user = reinterpret_cast<std::uintptr_t>(base) + kHeader + mode.shift;
  user = (user + align - 1) / align * align;
  unsigned char* p = reinterpret_cast<unsigned char*>(user);
  std::memcpy(p - kHeader, &base, sizeof(base));
  std::memcpy(p - kHeader + sizeof(base), &n, sizeof(n));
  if (mode.poison) std::memset(p, mode.fill, n);
  return p;
}

void release(void* ptr) {
  if (!ptr) return;
  unsigned char* p = static_cast<unsigned char*>(ptr);
  unsigned char* base = nullptr;
  std::size_t n = 0;
  std::memcpy(&base, p - kHeader, sizeof(base));
  std::memcpy(&n, p - kHeader + sizeof(base), sizeof(n));
  // A block freed now and reused by the next owner hands it these bytes.
  if (g_mode.poison) std::memset(p, static_cast<unsigned char>(~g_mode.fill), n);
  std::free(base);
}

void* allocate_or_throw(std::size_t n, std::size_t align) {
  void* p = allocate(n, align);
  if (!p) throw std::bad_alloc();
  return p;
}

}  // namespace

void* operator new(std::size_t n) { return allocate_or_throw(n, kHeader); }
void* operator new[](std::size_t n) { return allocate_or_throw(n, kHeader); }
void* operator new(std::size_t n, const std::nothrow_t&) noexcept { return allocate(n, kHeader); }
void* operator new[](std::size_t n, const std::nothrow_t&) noexcept { return allocate(n, kHeader); }
void* operator new(std::size_t n, std::align_val_t a) { return allocate_or_throw(n, static_cast<std::size_t>(a)); }
void* operator new[](std::size_t n, std::align_val_t a) { return allocate_or_throw(n, static_cast<std::size_t>(a)); }
void* operator new(std::size_t n, std::align_val_t a, const std::nothrow_t&) noexcept {
  return allocate(n, static_cast<std::size_t>(a));
}
void* operator new[](std::size_t n, std::align_val_t a, const std::nothrow_t&) noexcept {
  return allocate(n, static_cast<std::size_t>(a));
}
void operator delete(void* p) noexcept { release(p); }
void operator delete[](void* p) noexcept { release(p); }
void operator delete(void* p, std::size_t) noexcept { release(p); }
void operator delete[](void* p, std::size_t) noexcept { release(p); }
void operator delete(void* p, std::align_val_t) noexcept { release(p); }
void operator delete[](void* p, std::align_val_t) noexcept { release(p); }
void operator delete(void* p, std::size_t, std::align_val_t) noexcept { release(p); }
void operator delete[](void* p, std::size_t, std::align_val_t) noexcept { release(p); }
void operator delete(void* p, const std::nothrow_t&) noexcept { release(p); }
void operator delete[](void* p, const std::nothrow_t&) noexcept { release(p); }
void operator delete(void* p, std::align_val_t, const std::nothrow_t&) noexcept { release(p); }
void operator delete[](void* p, std::align_val_t, const std::nothrow_t&) noexcept { release(p); }

namespace {

constexpr int kRate = 48000;
constexpr double kPi = 3.14159265358979323846;

using Fx = std::vector<double>;

Fx row(int kind, std::initializer_list<std::pair<int, double>> fields) {
  Fx r(MIX_FX_STRIDE, 0.0);
  r[MIX_FX_KIND] = kind;
  r[MIX_FX_ENABLED] = 1;
  for (const auto& [field, value] : fields) r[static_cast<size_t>(field)] = value;
  return r;
}

Fx eq(int kind, double freq, double gain_db, double q) {
  return row(kind, {{MIX_FX_FREQ, freq}, {MIX_FX_GAIN_DB, gain_db}, {MIX_FX_Q, q}});
}

Fx compressor(double threshold_db, double ratio, double attack, double release, double knee_db, double makeup_db) {
  return row(MIX_FX_COMPRESSOR, {{MIX_FX_THRESHOLD_DB, threshold_db},
                                 {MIX_FX_RATIO, ratio},
                                 {MIX_FX_ATTACK, attack},
                                 {MIX_FX_RELEASE, release},
                                 {MIX_FX_KNEE_DB, knee_db},
                                 {MIX_FX_GAIN_DB, makeup_db}});
}

Fx limiter(double ceiling_db, double lookahead, double release) {
  return row(MIX_FX_LIMITER, {{MIX_FX_THRESHOLD_DB, ceiling_db}, {MIX_FX_ATTACK, lookahead}, {MIX_FX_RELEASE, release}});
}

/** The all-FX layout of bus_fx_tests (`everything_layout`), packed. */
struct Packed {
  std::vector<double> effects;
  std::vector<int> buses;
  int lanes = 3;
  int master_first = 0;
  int master_count = 0;
  int final_first = 0;
  int final_count = 0;
  double gain_db = 3.5;

  int effect_count() const { return static_cast<int>(effects.size() / MIX_FX_STRIDE); }
};

Packed everything() {
  const std::vector<std::vector<Fx>> lanes = {
      // Dialogue: high-pass, de-esser, gate, compressor, lane limiter.
      {eq(MIX_FX_HIGH_PASS, 80, 0, 0.7071),
       row(MIX_FX_DEESSER, {{MIX_FX_FREQ, 6500},
                            {MIX_FX_THRESHOLD_DB, -28},
                            {MIX_FX_RATIO, 4},
                            {MIX_FX_RANGE_DB, 6},
                            {MIX_FX_ATTACK, 0.001},
                            {MIX_FX_RELEASE, 0.05}}),
       row(MIX_FX_GATE, {{MIX_FX_THRESHOLD_DB, -50},
                         {MIX_FX_RANGE_DB, 20},
                         {MIX_FX_ATTACK, 0.001},
                         {MIX_FX_HOLD, 0.05},
                         {MIX_FX_RELEASE, 0.1}}),
       compressor(-24, 3, 0.005, 0.12, 6, 0), limiter(-3, 0.003, 0.05)},
      // Music: every EQ band kind and a duck under dialogue.
      {eq(MIX_FX_LOW_SHELF, 120, 3, 0.7071), eq(MIX_FX_PEAKING, 900, -4, 1.2), eq(MIX_FX_HIGH_SHELF, 9000, 2, 0.7071),
       eq(MIX_FX_LOW_PASS, 15000, 0, 0.7071),
       row(MIX_FX_DUCKER, {{MIX_FX_KEY, 0},
                           {MIX_FX_RANGE_DB, 9},
                           {MIX_FX_THRESHOLD_DB, -38},
                           {MIX_FX_ATTACK, 0.04},
                           {MIX_FX_HOLD, 0.15},
                           {MIX_FX_RELEASE, 0.4}})},
      // Effects lane: nothing but delay compensation.
      {},
  };
  const std::vector<Fx> master = {eq(MIX_FX_PEAKING, 3000, 1.5, 0.8), compressor(-18, 2, 0.01, 0.2, 6, 2),
                                  limiter(-2, 0.004, 0.1)};
  const std::vector<Fx> final_stage = {limiter(-1, 0.005, 0.1)};
  Packed p;
  auto append = [&](const std::vector<Fx>& rows) {
    const int first = p.effect_count();
    for (const Fx& r : rows) p.effects.insert(p.effects.end(), r.begin(), r.end());
    return first;
  };
  for (const auto& lane : lanes) p.buses.insert(p.buses.end(), {append(lane), static_cast<int>(lane.size()), 0});
  p.master_first = append(master);
  p.master_count = static_cast<int>(master.size());
  p.final_first = append(final_stage);
  p.final_count = static_cast<int>(final_stage.size());
  return p;
}

/** Programme-like material (chord, noise bursts, transients), interleaved stereo. */
std::vector<float> programme(int frames, double level, uint32_t seed) {
  uint32_t lcg = seed;
  std::vector<float> x(static_cast<size_t>(frames) * 2);
  for (int i = 0; i < frames; ++i) {
    const double t = static_cast<double>(i) / kRate;
    const double env = 0.55 + 0.45 * std::sin(2 * kPi * 0.7 * t);
    const double burst = std::fmod(t, 0.5) < 0.04 ? 1.0 : 0.25;
    for (int c = 0; c < 2; ++c) {
      lcg = lcg * 1664525u + 1013904223u;
      const double noise = static_cast<double>(static_cast<int32_t>(lcg)) / 2147483648.0;
      const double v = 0.4 * std::sin(2 * kPi * (220.0 + 3 * c) * t) + 0.25 * std::sin(2 * kPi * 1760.0 * t + c) +
                       0.3 * burst * noise;
      x[2 * static_cast<size_t>(i) + c] = static_cast<float>(level * env * v);
    }
  }
  return x;
}

std::vector<std::vector<float>> inputs(int frames) {
  auto dialogue = programme(frames, 0.6, 21);
  // Pauses, so the gate and the duck both open and close.
  for (int i = 0; i < frames; ++i) {
    if (std::fmod(static_cast<double>(i) / kRate, 1.5) > 1.0) {
      dialogue[2 * static_cast<size_t>(i)] *= 0.001f;
      dialogue[2 * static_cast<size_t>(i) + 1] *= 0.001f;
    }
  }
  return {dialogue, programme(frames, 0.7, 22), programme(frames, 0.2, 23)};
}

/** Every byte the golden produces, appended to `out`. */
template <typename T>
void append_bytes(std::vector<unsigned char>* out, const T* data, size_t count) {
  const auto* bytes = reinterpret_cast<const unsigned char*>(data);
  out->insert(out->end(), bytes, bytes + count * sizeof(T));
}

/**
 * The worklet's graph (128-frame quanta, a retune, a seek reset) and the
 * export's fx session (4096-frame chunks) over the same lanes: output
 * samples and meter readings.
 */
std::vector<unsigned char> run_golden(const Packed& p, const std::vector<std::vector<float>>& lanes) {
  std::vector<unsigned char> result;
  const int frames = static_cast<int>(lanes[0].size() / 2);

  BusGraphHandle* g = bus_graph_create(kRate, 2, p.effects.data(), p.effect_count(), p.buses.data(), p.lanes,
                                       p.master_first, p.master_count, p.gain_db, p.final_first, p.final_count,
                                       MIX_BUS_FLAG_METER);
  CHECK(g != nullptr);
  if (!g) return result;
  constexpr int kQuantum = 128;
  std::vector<float> block(static_cast<size_t>(p.lanes + 1) * kQuantum * 2);
  std::vector<float> out(static_cast<size_t>(kQuantum) * 2);
  double meters[64];
  for (int begin = 0; begin < frames; begin += kQuantum) {
    const int n = std::min(kQuantum, frames - begin);
    std::fill(block.begin(), block.end(), 0.f);
    for (int l = 0; l < p.lanes; ++l) {
      std::memcpy(block.data() + static_cast<size_t>(l) * n * 2, lanes[l].data() + static_cast<size_t>(begin) * 2,
                  static_cast<size_t>(n) * 2 * sizeof(float));
    }
    CHECK(bus_graph_process(g, block.data(), out.data(), n) == CS_OK);
    append_bytes(&result, out.data(), static_cast<size_t>(n) * 2);
    if (begin == frames / 2) {
      // Retune in place (same structure), as a slider drag does.
      std::vector<double> retuned = p.effects;
      retuned[static_cast<size_t>(p.master_first) * MIX_FX_STRIDE + MIX_FX_GAIN_DB] = -1.0;
      CHECK(bus_graph_update(g, retuned.data(), p.effect_count(), p.buses.data(), p.lanes, p.master_first,
                             p.master_count, p.gain_db, p.final_first, p.final_count) == CS_OK);
    }
    if ((begin / kQuantum) % 64 == 63) {
      const int m = bus_graph_meters(g, meters, 64);
      CHECK(m > 0);
      append_bytes(&result, meters, static_cast<size_t>(std::max(m, 0)));
    }
  }
  bus_graph_reset(g);
  CHECK(bus_graph_process(g, block.data(), out.data(), kQuantum) == CS_OK);
  append_bytes(&result, out.data(), static_cast<size_t>(kQuantum) * 2);
  bus_graph_destroy(g);

  // The export session: each lane one clip entry routed to its bus.
  MixFxSession* s = mix_bus_session_create(kRate, 2, p.lanes, p.effects.data(), p.effect_count(), p.buses.data(),
                                           p.lanes, p.master_first, p.master_count, p.gain_db, p.final_first,
                                           p.final_count, MIX_BUS_FLAG_METER);
  CHECK(s != nullptr);
  if (!s) return result;
  std::vector<float> pcm;
  std::vector<int> meta;
  std::vector<double> rows;
  for (int e = 0; e < p.lanes; ++e) {
    meta.insert(meta.end(), {static_cast<int>(pcm.size()), frames, 2, kRate, 0, frames});
    for (int c = 0; c < 2; ++c) {
      for (int i = 0; i < frames; ++i) pcm.push_back(lanes[e][2 * static_cast<size_t>(i) + c]);
    }
    rows.insert(rows.end(), {static_cast<double>(e), 0.0, static_cast<double>(frames) / kRate, 0.0, 1.0, 0.0, 0.0,
                             1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, static_cast<double>(e), static_cast<double>(e)});
  }
  std::vector<float> mixed(static_cast<size_t>(frames) * 2);
  for (int begin = 0; begin < frames; begin += 4096) {
    const int n = std::min(4096, frames - begin);
    CHECK(mix_fx_session_range(s, mixed.data() + static_cast<size_t>(begin) * 2, n, begin, pcm.data(),
                               static_cast<int>(pcm.size()), meta.data(), p.lanes, rows.data(), p.lanes, nullptr, 0,
                               MIX_FLAG_EFFECTS) == CS_OK);
  }
  append_bytes(&result, mixed.data(), mixed.size());
  const int m = mix_fx_session_meters(s, meters, 64);
  CHECK(m > 0);
  append_bytes(&result, meters, static_cast<size_t>(std::max(m, 0)));
  mix_fx_session_destroy(s);
  return result;
}

bool all_finite_floats(const std::vector<unsigned char>& bytes, size_t float_bytes) {
  for (size_t i = 0; i + sizeof(float) <= float_bytes; i += sizeof(float)) {
    float v;
    std::memcpy(&v, bytes.data() + i, sizeof(v));
    if (!std::isfinite(v)) return false;
  }
  return true;
}

}  // namespace

TEST_CASE(bus_golden_is_identical_under_poisoned_and_shifted_allocations) {
  const Packed p = everything();
  const auto lanes = inputs(2 * kRate);

  g_mode = AllocMode{};
  const std::vector<unsigned char> reference = run_golden(p, lanes);
  CHECK(!reference.empty());
  // The first quanta are graph output samples; a poisoned read would show
  // up as NaN there long before the comparison below.
  CHECK(all_finite_floats(reference, 128 * 2 * sizeof(float)));

  const AllocMode modes[] = {
      {true, 0xFF, 16},         // NaN in every float / double, odd 16-byte slot
      {true, 0x7F, 48},         // huge finite values
      {true, 0xA5, 4096 + 16},  // noise, a different page offset
      {true, 0x00, 0},          // zeroed (wasm's fresh memory.grow pages), refilled 0xFF on free
  };
  for (const AllocMode& mode : modes) {
    // Churn the heap first, so blocks come back holding stale poison.
    g_mode = mode;
    for (int i = 0; i < 64; ++i) delete[] new float[static_cast<size_t>(1024 + 97 * i)];
    const std::vector<unsigned char> run = run_golden(p, lanes);
    g_mode = AllocMode{};
    CHECK(run.size() == reference.size());
    CHECK(run.size() == reference.size() && std::memcmp(run.data(), reference.data(), run.size()) == 0);
  }
}

TEST_CASE(poisoning_allocator_does_poison) {
  // The harness itself: a poisoned block really holds the fill, and blocks
  // really move with the shift, so the case above is not vacuous.
  g_mode = AllocMode{true, 0xFF, 16};
  auto* a = new float[8];
  bool poisoned = true;
  for (int i = 0; i < 8; ++i) poisoned = poisoned && std::isnan(a[i]);
  CHECK(poisoned);
  g_mode = AllocMode{true, 0x7F, 4096 + 16};
  auto* b = new double[1];
  CHECK(*b > 1e300);
  CHECK(reinterpret_cast<std::uintptr_t>(b) % 16 == 0);
  auto* c = new (std::align_val_t{64}) float[16];
  CHECK(reinterpret_cast<std::uintptr_t>(c) % 64 == 0);
  ::operator delete[](c, std::align_val_t{64});
  delete[] b;
  delete[] a;
  g_mode = AllocMode{};
}
