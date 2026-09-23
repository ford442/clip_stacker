#include "resampler.h"

#include <cmath>
#include <cstring>

namespace media_engine {
namespace {

// GCC/Clang vector extensions: lowers to SIMD128 (`f32x4.mul` / `f32x4.add`)
// under Emscripten's -msimd128 and to SSE on the host test build, so the host
// tests run the exact inner product the WASM module ships.
typedef float v4f __attribute__((vector_size(16)));

static_assert(kSincTaps % 4 == 0, "FIR taps must fill whole f32x4 lanes");

inline v4f load4(const float* p) {
  v4f v;
  std::memcpy(&v, p, sizeof(v));
  return v;
}

inline void store4(float* p, v4f v) { std::memcpy(p, &v, sizeof(v)); }

inline v4f splat(float x) { return v4f{x, x, x, x}; }

constexpr double kPi = 3.14159265358979323846;
constexpr int kRowFloats = (kSincPhases + 1) * kSincTaps;
constexpr int kTableSlots = 4;

// Zero-initialized (cutoff 0 = empty slot) so the tables live in BSS and
// cost nothing in the .wasm binary.
struct TableSlot {
  double cutoff;
  alignas(16) float rows[kRowFloats];
};
TableSlot g_slots[kTableSlots];
int g_next_slot = 0;

double bessel_i0(double x) {
  const double half = 0.5 * x;
  double term = 1.0;
  double sum = 1.0;
  for (int k = 1; k < 64; ++k) {
    const double r = half / static_cast<double>(k);
    term *= r * r;
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

void build_table(double cutoff, float* rows) {
  const double inv_i0_beta = 1.0 / bessel_i0(kSincKaiserBeta);
  const double half = static_cast<double>(kSincHalfTaps);
  double taps[kSincTaps];
  for (int p = 0; p <= kSincPhases; ++p) {
    const double frac = static_cast<double>(p) / static_cast<double>(kSincPhases);
    double sum = 0.0;
    for (int j = 0; j < kSincTaps; ++j) {
      // Distance (source frames) from the interpolated position to tap j.
      const double x = static_cast<double>(j - kSincHalfTaps + 1) - frac;
      const double w = x / half;
      double h = 0.0;
      if (w > -1.0 && w < 1.0) {
        const double arg = kPi * cutoff * x;
        const double sinc = x == 0.0 ? 1.0 : std::sin(arg) / arg;
        h = sinc * bessel_i0(kSincKaiserBeta * std::sqrt(1.0 - w * w)) * inv_i0_beta;
      }
      taps[j] = h;
      sum += h;
    }
    // Unity DC gain on every phase: no phase-dependent level ripple.
    const double norm = sum != 0.0 ? 1.0 / sum : 0.0;
    float* row = rows + p * kSincTaps;
    for (int j = 0; j < kSincTaps; ++j) row[j] = static_cast<float>(taps[j] * norm);
  }
}

float dot_taps(const float* coeff, const float* x) {
  v4f acc = splat(0.f);
  for (int k = 0; k < kSincTaps; k += 4) acc += load4(coeff + k) * load4(x + k);
  return (acc[0] + acc[1]) + (acc[2] + acc[3]);
}

}  // namespace

double sinc_cutoff_for_step(double step) {
  return step > 1.0 ? kSincRolloff / step : kSincRolloff;
}

const float* sinc_table(double cutoff) {
  for (TableSlot& slot : g_slots) {
    if (slot.cutoff == cutoff) return slot.rows;
  }
  TableSlot& slot = g_slots[g_next_slot];
  g_next_slot = (g_next_slot + 1) % kTableSlots;
  build_table(cutoff, slot.rows);
  slot.cutoff = cutoff;
  return slot.rows;
}

void resample_sinc(
    const SourceSlice* slices,
    int channels,
    double pos,
    const float* rows,
    float* out) {
  const double base = std::floor(pos);
  const int i = static_cast<int>(base);
  const double phase = (pos - base) * static_cast<double>(kSincPhases);
  int p = static_cast<int>(phase);
  if (p >= kSincPhases) p = kSincPhases - 1;
  const v4f u = splat(static_cast<float>(phase - static_cast<double>(p)));

  // Linear interpolation between adjacent phases keeps 512 rows accurate to
  // well below the f32 noise floor.
  alignas(16) float coeff[kSincTaps];
  const float* r0 = rows + p * kSincTaps;
  const float* r1 = r0 + kSincTaps;
  for (int k = 0; k < kSincTaps; k += 4) {
    const v4f a = load4(r0 + k);
    store4(coeff + k, a + (load4(r1 + k) - a) * u);
  }

  const int first_tap = i - kSincHalfTaps + 1;
  for (int c = 0; c < channels; ++c) {
    const SourceSlice& slice = slices[c];
    const int offset = first_tap - slice.first_frame;
    if (offset >= 0 && offset + kSincTaps <= slice.frame_count) {
      out[c] = dot_taps(coeff, slice.data + offset);
      continue;
    }
    // Window crosses the slice / clip edge: zero-pad, then run the same
    // lane order so results never depend on how JS cut the slices.
    alignas(16) float window[kSincTaps];
    for (int k = 0; k < kSincTaps; ++k) window[k] = slice_sample(slice, first_tap + k);
    out[c] = dot_taps(coeff, window);
  }
}

void resample_linear(
    const SourceSlice* slices,
    int channels,
    double pos,
    int clip_frames,
    float* out) {
  const int last = clip_frames - 1;
  const int i0 = static_cast<int>(pos);
  const int i1 = i0 < last ? i0 + 1 : last;
  const float t = static_cast<float>(pos - static_cast<double>(i0));
  for (int c = 0; c < channels; ++c) {
    const float a = slice_sample(slices[c], i0);
    const float b = slice_sample(slices[c], i1);
    out[c] = a + (b - a) * t;
  }
}

}  // namespace media_engine
