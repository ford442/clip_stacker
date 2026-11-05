// libFuzzer target for the effect rows (clang, CLIP_STACKER_HOST_FUZZ=ON;
// scripts/fuzz-native.sh). The input bytes are a whole case: lane / chain
// layout, raw f64 parameter bit patterns (so NaN, inf, huge and negative
// values all reach the clamps), and raw f32 samples. It traps when an output
// sample is non-finite or subnormal, or a final limiter's ceiling is
// exceeded; ASan / UBSan (incl. float-cast-overflow) catch the rest.
// fx_property_tests is the seeded, deterministic sibling that ctest runs.

#include "audio_mix.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

struct Reader {
  const uint8_t* data;
  size_t size;
  size_t pos = 0;
  uint8_t byte() { return pos < size ? data[pos++] : 0; }
  double f64() {
    double v = 0;
    if (pos + sizeof(v) <= size) std::memcpy(&v, data + pos, sizeof(v));
    pos += sizeof(v);
    return v;
  }
  size_t left() const { return pos < size ? size - pos : 0; }
};

void check_output(const float* out, size_t n, double ceiling) {
  for (size_t i = 0; i < n; ++i) {
    const float v = out[i];
    if (!std::isfinite(v) || std::fpclassify(v) == FP_SUBNORMAL) __builtin_trap();
    if (std::fabs(v) > ceiling) __builtin_trap();
  }
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  Reader in{data, size};
  const int lanes = 1 + in.byte() % 4;
  std::vector<int> buses;
  std::vector<double> effects;
  auto add_rows = [&](int count, int lanes_before) {
    for (int i = 0; i < count; ++i) {
      std::vector<double> row(MIX_FX_STRIDE);
      row[MIX_FX_KIND] = in.byte() % 12;
      row[MIX_FX_ENABLED] = in.byte() & 1;
      for (int f = MIX_FX_FREQ; f < MIX_FX_STRIDE; ++f) row[f] = in.f64();
      if (in.byte() & 1) row[MIX_FX_KEY] = static_cast<int>(in.byte() % (lanes_before + 3)) - 2;
      effects.insert(effects.end(), row.begin(), row.end());
    }
  };
  for (int l = 0; l < lanes; ++l) {
    const int first = static_cast<int>(effects.size() / MIX_FX_STRIDE);
    const int count = in.byte() % 9;
    add_rows(count, l);
    buses.insert(buses.end(), {first, count});
  }
  const int master_first = static_cast<int>(effects.size() / MIX_FX_STRIDE);
  const int master_count = in.byte() % 5;
  add_rows(master_count, 0);
  const int final_first = static_cast<int>(effects.size() / MIX_FX_STRIDE);
  const int final_count = in.byte() % 3;
  add_rows(final_count, 0);
  const double gain_db = (in.byte() & 1) ? in.f64() : 0.0;
  const int flags = in.byte() & 1 ? MIX_BUS_FLAG_METER : 0;
  if (effects.empty()) effects.assign(MIX_FX_STRIDE, 0.0);
  const int effect_count = static_cast<int>(effects.size() / MIX_FX_STRIDE);

  // A final limiter's output clamp is a guarantee: its ceiling bounds the output.
  double ceiling = 3.4e38;
  for (int i = 0; i < final_count; ++i) {
    const double* row = effects.data() + static_cast<size_t>(final_first + i) * MIX_FX_STRIDE;
    if (row[MIX_FX_KIND] == MIX_FX_LIMITER && row[MIX_FX_ENABLED] != 0.0) {
      const double c = std::isfinite(row[MIX_FX_THRESHOLD_DB]) ? std::max(-24.0, std::min(0.0, row[MIX_FX_THRESHOLD_DB]))
                                                               : -1.0;
      ceiling = std::min(ceiling, std::pow(10.0, c / 20.0) * (1.0 + 1e-6));
    }
  }

  BusGraphHandle* g = bus_graph_create(48000, 2, effects.data(), effect_count, buses.data(), lanes, master_first,
                                       master_count, gain_db, final_first, final_count, flags);
  if (!g) return 0;

  // Samples: the rest of the input, raw f32, spread over the lanes; then a
  // silent tail so delay lines and envelopes ring out.
  const int blocks = lanes + 1;
  const int signal_frames = static_cast<int>(std::min<size_t>(in.left() / (sizeof(float) * 2 * blocks), 8192));
  const int frames = signal_frames + 4096;
  std::vector<float> lane_pcm(static_cast<size_t>(blocks) * frames * 2, 0.f);
  for (int b = 0; b < blocks; ++b) {
    for (int i = 0; i < signal_frames * 2; ++i) {
      float v = 0.f;
      if (in.left() >= sizeof(v)) std::memcpy(&v, in.data + in.pos, sizeof(v));
      in.pos += sizeof(v);
      lane_pcm[static_cast<size_t>(b) * frames * 2 + i] = v;
    }
  }
  constexpr int kQuantum = 128;
  std::vector<float> quantum(static_cast<size_t>(blocks) * kQuantum * 2);
  std::vector<float> out(static_cast<size_t>(kQuantum) * 2);
  double meters[64];
  for (int begin = 0; begin < frames; begin += kQuantum) {
    const int n = std::min(kQuantum, frames - begin);
    for (int b = 0; b < blocks; ++b) {
      std::copy_n(lane_pcm.data() + (static_cast<size_t>(b) * frames + begin) * 2, static_cast<size_t>(n) * 2,
                  quantum.data() + static_cast<size_t>(b) * n * 2);
    }
    if (bus_graph_process(g, quantum.data(), out.data(), n) != 0) __builtin_trap();
    check_output(out.data(), static_cast<size_t>(n) * 2, ceiling);
    if ((begin / kQuantum) % 8 == 7) {
      const int m = bus_graph_meters(g, meters, 64);
      for (int i = 0; i < m; ++i) {
        if (std::isnan(meters[i])) __builtin_trap();
      }
    }
  }
  bus_graph_destroy(g);

  // The first lane's rows as a clip insert chain, at a fuzzed design rate.
  const double rate = 8000.0 + static_cast<double>(in.byte()) * 700.0;
  MixInsertChain* chain = insert_chain_create(rate, effects.data(), buses[1]);
  if (chain) {
    std::vector<float> planar(static_cast<size_t>(frames) * 2);
    for (int i = 0; i < frames; ++i) {
      planar[i] = lane_pcm[2 * static_cast<size_t>(i)];
      planar[static_cast<size_t>(frames) + i] = lane_pcm[2 * static_cast<size_t>(i) + 1];
    }
    bool finite_in = true;
    for (float v : planar) finite_in = finite_in && std::isfinite(v) && std::fpclassify(v) != FP_SUBNORMAL;
    insert_chain_process(chain, planar.data(), frames, 2);
    // An inactive chain is an identity (its input may be anything); an
    // active one flushes non-finite and subnormal samples.
    if (finite_in) check_output(planar.data(), planar.size(), 3.4e38);
    insert_chain_destroy(chain);
  }
  return 0;
}
