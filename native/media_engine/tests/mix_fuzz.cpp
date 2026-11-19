// libFuzzer target for the stateless timeline mix (clang,
// CLIP_STACKER_HOST_FUZZ=ON; scripts/fuzz-native.sh). The input bytes are a
// whole call: output shape, a PCM blob of a fuzzed `pcm_floats` length
// (allocated exactly, so ASan sees any read past it), slice metadata as raw
// or near-valid int32s, schedule rows and keyframes as raw or near-valid f64
// bit patterns. The contract is the bounds checks: a non-OK status is fine,
// an ASan / UBSan (incl. float-cast-overflow) finding is not. On success it
// also checks the documented chunk invariance: the same range mixed in two
// calls, split at a fuzzed frame, is bit-identical to one call.

#include "audio_mix.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

namespace {

struct Reader {
  const uint8_t* data;
  size_t size;
  size_t pos = 0;
  uint8_t byte() { return pos < size ? data[pos++] : 0; }
  template <typename T>
  T raw() {
    T v{};
    if (pos + sizeof(v) <= size) std::memcpy(&v, data + pos, sizeof(v));
    pos += sizeof(v);
    return v;
  }
  uint16_t u16() { return raw<uint16_t>(); }
};

// Mostly plausible values (so the mix loop runs), sometimes raw bits (so
// every validation branch and clamp sees NaN, inf, huge and negative values).
double near_f64(Reader& in, double plausible_max) {
  switch (in.byte() % 4) {
    case 0:
      return in.raw<double>();
    case 1:
      return 0.0;
    default:
      return static_cast<double>(in.u16()) / 65535.0 * plausible_max;
  }
}

int near_i32(Reader& in, int plausible_max) {
  switch (in.byte() % 5) {
    case 0:
      return in.raw<int32_t>();
    case 1:
      return static_cast<int>(in.byte() % 3) - 1;
    case 2: {
      // Near INT_MIN / INT_MAX: raw bits almost never land there, and that
      // is where index arithmetic wraps.
      const int near = static_cast<int>(in.u16() % 4096);
      return (in.byte() & 1) ? std::numeric_limits<int>::min() + near : std::numeric_limits<int>::max() - near;
    }
    default:
      return plausible_max > 0 ? static_cast<int>(in.u16() % (plausible_max + 1)) : 0;
  }
}

int mix(std::vector<float>& out, int frames, double start, int rate, int channels, const std::vector<float>& pcm,
        const std::vector<int>& slices, int slice_count, const std::vector<double>& entries, int entry_count,
        const std::vector<double>& keys, int key_count, int flags) {
  return mix_timeline_audio_range(out.data(), frames, start, rate, channels, pcm.empty() ? nullptr : pcm.data(),
                                  static_cast<int>(pcm.size()), slices.empty() ? nullptr : slices.data(),
                                  slice_count, entries.empty() ? nullptr : entries.data(), entry_count,
                                  keys.empty() ? nullptr : keys.data(), key_count, flags);
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  Reader in{data, size};

  static constexpr int kRates[] = {8000, 22050, 44100, 48000, 96000, 1, 7};
  const int out_frames = 1 + in.u16() % 2048;
  const uint8_t start_mode = in.byte() % 8;
  const double start_frame =
      start_mode == 0 ? in.raw<double>() : start_mode < 4 ? 0.0 : static_cast<double>(in.u16() % 8192);
  const int out_rate = (in.byte() % 8 == 0) ? in.raw<int32_t>() : kRates[in.byte() % 7];
  const int out_channels = in.byte() % 4;  // 0 and 3 are invalid
  const int flags = in.byte() & 3;          // MIX_FLAG_EFFECTS must be refused here

  // The blob is exactly `pcm_floats` long: a slice the checks let through
  // that runs past it is a heap-buffer-overflow.
  const int pcm_floats = in.u16() % 4097;
  std::vector<float> pcm(static_cast<size_t>(pcm_floats));

  const int slice_count = in.byte() % 5;
  std::vector<int> slices(static_cast<size_t>(slice_count) * MIX_SLICE_STRIDE);
  for (int s = 0; s < slice_count; ++s) {
    int* m = slices.data() + static_cast<size_t>(s) * MIX_SLICE_STRIDE;
    const int channels = near_i32(in, 3);
    m[MIX_SLICE_CHANNELS] = channels;
    const int planes = channels >= 2 ? 2 : 1;
    if (in.byte() % 4 == 0) {
      // Anything: offsets and lengths the bounds check must refuse.
      m[MIX_SLICE_PCM_OFFSET] = near_i32(in, pcm_floats);
      m[MIX_SLICE_FRAMES] = near_i32(in, pcm_floats);
    } else {
      // In bounds, or one float past the end (the edge of cs_span_ok).
      const int offset = in.u16() % (pcm_floats + 1);
      const int room = (pcm_floats - offset) / planes;
      m[MIX_SLICE_PCM_OFFSET] = offset;
      m[MIX_SLICE_FRAMES] = in.u16() % (room + 1) + ((in.byte() % 16 == 0) ? 1 : 0);
    }
    m[MIX_SLICE_SAMPLE_RATE] = (in.byte() & 1) ? kRates[in.byte() % 7] : near_i32(in, 192000);
    m[MIX_SLICE_FIRST_FRAME] = near_i32(in, 8192);
    m[MIX_SLICE_CLIP_FRAMES] = near_i32(in, 16384);
  }

  const int key_count = in.byte() % 9;
  std::vector<double> keys(static_cast<size_t>(key_count) * MIX_KEY_STRIDE);
  double key_time = 0.0;
  for (int k = 0; k < key_count; ++k) {
    double* row = keys.data() + static_cast<size_t>(k) * MIX_KEY_STRIDE;
    // Sorted within a curve is the documented layout, but nothing enforces
    // it: an unsorted raw time must be survivable too.
    key_time += near_f64(in, 0.25);
    row[MIX_KEY_TIME] = (in.byte() % 8 == 0) ? in.raw<double>() : key_time;
    row[MIX_KEY_VALUE] = near_f64(in, 2.0) - ((in.byte() & 1) ? 1.0 : 0.0);
    row[MIX_KEY_EASING] = (in.byte() % 4 == 0) ? in.raw<double>() : static_cast<double>(in.byte() % 5);
    for (int f = MIX_KEY_X1; f < MIX_KEY_STRIDE; ++f) row[f] = near_f64(in, 1.0);
  }

  const int entry_count = in.byte() % 6;
  std::vector<double> entries(static_cast<size_t>(entry_count) * MIX_ENTRY_STRIDE);
  for (int e = 0; e < entry_count; ++e) {
    double* row = entries.data() + static_cast<size_t>(e) * MIX_ENTRY_STRIDE;
    row[MIX_ENTRY_SLICE_INDEX] = (in.byte() % 4 == 0) ? in.raw<double>() : static_cast<double>(in.byte() % 6);
    row[MIX_ENTRY_TIMELINE_START] = near_f64(in, 0.2) - ((in.byte() & 1) ? 0.05 : 0.0);
    row[MIX_ENTRY_DURATION] = near_f64(in, 0.3);
    row[MIX_ENTRY_BUFFER_OFFSET] = near_f64(in, 0.2);
    row[MIX_ENTRY_VOLUME] = near_f64(in, 2.0);
    row[MIX_ENTRY_FADE_IN] = near_f64(in, 0.1);
    row[MIX_ENTRY_FADE_OUT] = near_f64(in, 0.1);
    row[MIX_ENTRY_PLAYBACK_RATE] = (in.byte() & 1) ? 1.0 : near_f64(in, 4.0);
    for (int f : {MIX_ENTRY_VOLUME_KEYS, MIX_ENTRY_PAN_KEYS}) {
      if (in.byte() % 8 == 0) {
        // Out of range, fractional or non-finite: CS_ERANGE, never a read.
        row[f] = (in.byte() & 1) ? in.raw<double>() : static_cast<double>(in.byte() % (key_count + 2));
        row[f + 1] = (in.byte() & 1) ? in.raw<double>() : static_cast<double>(in.byte() % (key_count + 2));
      } else {
        const int first = in.byte() % (key_count + 1);
        row[f] = first;
        row[f + 1] = in.byte() % (key_count - first + 1);
      }
    }
  }

  // Samples: the rest of the input, raw f32 (NaN and inf included).
  for (float& v : pcm) v = in.raw<float>();

  // Sized for the valid channel counts; with 0 or 3 the call must refuse
  // before writing.
  const int out_ch_alloc = out_channels == 1 ? 1 : 2;
  std::vector<float> whole(static_cast<size_t>(out_frames) * out_ch_alloc);
  const int rc = mix(whole, out_frames, start_frame, out_rate, out_channels, pcm, slices, slice_count, entries,
                     entry_count, keys, key_count, flags);
  // A cs_status, and never "internal invariant broke".
  if (rc > 0 || rc <= CS_EINTERNAL) __builtin_trap();
  if ((flags & MIX_FLAG_EFFECTS) && rc != CS_EINVAL) __builtin_trap();
  if (rc != CS_OK || out_frames < 2) return 0;
  // Past 2^53 the second chunk's start is not a whole f64 (refused by design).
  if (start_frame + out_frames > 9007199254740992.0) return 0;

  // Chunk invariance: [start, start + split) then [start + split, end).
  const int split = 1 + static_cast<int>(in.byte()) % (out_frames - 1);
  std::vector<float> head(static_cast<size_t>(split) * out_ch_alloc);
  std::vector<float> tail(static_cast<size_t>(out_frames - split) * out_ch_alloc);
  if (mix(head, split, start_frame, out_rate, out_channels, pcm, slices, slice_count, entries, entry_count, keys,
          key_count, flags) != CS_OK) {
    __builtin_trap();
  }
  if (mix(tail, out_frames - split, start_frame + split, out_rate, out_channels, pcm, slices, slice_count, entries,
          entry_count, keys, key_count, flags) != CS_OK) {
    __builtin_trap();
  }
  if (std::memcmp(whole.data(), head.data(), head.size() * sizeof(float)) != 0) __builtin_trap();
  if (std::memcmp(whole.data() + head.size(), tail.data(), tail.size() * sizeof(float)) != 0) __builtin_trap();
  return 0;
}
