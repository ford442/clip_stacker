// libFuzzer target for the stabilizer's C API (clang,
// CLIP_STACKER_HOST_FUZZ=ON; scripts/fuzz-native.sh). The input bytes pick
// the frame size (tiny, odd and degenerate sizes included; sometimes raw
// int32s for stab_create's validation), the smoothing radius, a texture and a
// per-frame shift, so the corner detector, the pyramid tracker and RANSAC all
// see real motion as well as noise and flat frames. Every buffer is exactly
// the size the API documents, so ASan sees any read or write past it; UBSan
// (incl. float-cast-overflow) checks the float -> int sampling. It traps when
// a correction matrix or the zoom is non-finite, or the zoom is below 1.

#include "video_stabilize.h"

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
  int32_t i32() {
    int32_t v = 0;
    if (pos + sizeof(v) <= size) std::memcpy(&v, data + pos, sizeof(v));
    pos += sizeof(v);
    return v;
  }
};

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  Reader in{data, size};

  // Raw sizes exercise the create-time validation only: a valid one could be
  // 8192 x 8192, too slow to push frames through at fuzzing rates.
  if (in.byte() % 16 == 0) {
    StabHandle* h = stab_create(in.i32(), in.i32(), in.i32());
    stab_destroy(h);
    return 0;
  }

  const int width = 1 + in.byte() % 160;
  const int height = 1 + in.byte() % 120;
  const int radius = static_cast<int>(in.byte()) - 8;  // clamped to [1, 120]
  const int frames = 1 + in.byte() % 8;
  StabHandle* h = stab_create(width, height, radius);
  if (!h) __builtin_trap();

  // A texture tiled from the input, or (so short inputs reach the tracker
  // and RANSAC too) seeded random 4 x 4 blocks; shifted by a fuzzed integer
  // motion per frame, plus optional per-pixel noise.
  const size_t pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
  const bool blocks = in.byte() & 1;
  const uint32_t seed = static_cast<uint32_t>(in.i32());
  const size_t texture_size = in.pos < in.size ? in.size - in.pos : 0;
  const uint8_t* texture = data + in.pos;
  const int noise = in.byte() % 4;
  std::vector<uint8_t> gray(pixels);
  int ox = 0;
  int oy = 0;
  for (int f = 0; f < frames; ++f) {
    ox += static_cast<int>(in.byte() % 9) - 4;
    oy += static_cast<int>(in.byte() % 9) - 4;
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        uint8_t v = 0;
        if (blocks) {
          uint32_t k = seed ^ (static_cast<uint32_t>((x + ox) >> 2) * 0x9E3779B1u) ^
                       (static_cast<uint32_t>((y + oy) >> 2) * 0x85EBCA77u);
          k ^= k >> 15;
          k *= 0x2C1B3C6Du;
          k ^= k >> 12;
          v = static_cast<uint8_t>(k);
        } else if (texture_size > 0) {
          const size_t tx = static_cast<size_t>((x + ox) & 63);
          const size_t ty = static_cast<size_t>((y + oy) & 63);
          v = texture[(ty * 64 + tx) % texture_size];
        }
        if (noise != 0) v = static_cast<uint8_t>(v ^ (in.byte() & ((1 << (2 * noise)) - 1)));
        gray[static_cast<size_t>(y) * static_cast<size_t>(width) + static_cast<size_t>(x)] = v;
      }
    }
    const int index = stab_push_frame(h, gray.data());
    if (index != f) __builtin_trap();
  }
  if (stab_frame_count(h) != frames) __builtin_trap();
  if (stab_finalize(h) != CS_OK) __builtin_trap();
  if (stab_finalize(h) != CS_OK) __builtin_trap();  // idempotent
  if (stab_push_frame(h, gray.data()) != CS_ESTATE) __builtin_trap();

  const float zoom = stab_get_zoom(h);
  if (!std::isfinite(zoom) || zoom < 1.f) __builtin_trap();
  if (!std::isfinite(stab_get_max_correction(h))) __builtin_trap();

  std::vector<uint8_t> rgba_in(pixels * 4);
  for (size_t i = 0; i < rgba_in.size(); ++i) rgba_in[i] = gray[(i / 4) % pixels];
  std::vector<uint8_t> rgba_out(pixels * 4);
  for (int f = -1; f <= frames; ++f) {
    float m[STAB_MATRIX_FLOATS];
    stab_get_matrix(h, f, m);
    for (float v : m) {
      if (!std::isfinite(v)) __builtin_trap();
    }
    stab_apply_warp(h, rgba_in.data(), rgba_out.data(), f);
  }
  stab_destroy(h);
  return 0;
}
