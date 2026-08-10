#include "time_stretch.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace {

constexpr int kMinHop = 64;
constexpr int kMaxHop = 4096;
constexpr int kMaxChannels = 8;

float hann(int i, int n) {
  if (n <= 1) return 1.f;
  return 0.5f * (1.f - std::cos(2.f * static_cast<float>(M_PI) * static_cast<float>(i) /
                               static_cast<float>(n - 1)));
}

int clampHop(int hop) {
  if (hop < kMinHop) return kMinHop;
  if (hop > kMaxHop) return kMaxHop;
  return hop;
}

/** Linear sample at fractional frame index for one channel. */
float sampleAt(const float* ch, int frames, float pos) {
  if (frames <= 0) return 0.f;
  if (pos <= 0.f) return ch[0];
  if (pos >= static_cast<float>(frames - 1)) return ch[frames - 1];
  const int i0 = static_cast<int>(pos);
  const int i1 = std::min(frames - 1, i0 + 1);
  const float frac = pos - static_cast<float>(i0);
  return ch[i0] * (1.f - frac) + ch[i1] * frac;
}

/**
 * Overlap-add WSOLA using a source-offset map (one entry per synthesis hop).
 * Window length = 2 * hop for 50% overlap.
 */
int remapImpl(
    const float* input,
    int in_frames,
    int channels,
    const float* source_offsets,
    int num_offsets,
    int hop,
    float* output,
    int out_frames) {
  if (!input || !output || !source_offsets || in_frames <= 0 || out_frames <= 0 ||
      channels <= 0 || channels > kMaxChannels || num_offsets <= 0) {
    return 1;
  }

  hop = clampHop(hop);
  const int win = hop * 2;
  std::vector<float> window(static_cast<size_t>(win));
  for (int i = 0; i < win; ++i) window[static_cast<size_t>(i)] = hann(i, win);

  std::memset(output, 0, static_cast<size_t>(out_frames) * static_cast<size_t>(channels) *
                             sizeof(float));
  std::vector<float> norm(static_cast<size_t>(out_frames), 0.f);

  for (int h = 0; h < num_offsets; ++h) {
    const int outCenter = h * hop;
    if (outCenter >= out_frames) break;
    const float srcCenter = source_offsets[h];
    const int outStart = outCenter - hop;
    const float srcStart = srcCenter - static_cast<float>(hop);

    for (int i = 0; i < win; ++i) {
      const int outIdx = outStart + i;
      if (outIdx < 0 || outIdx >= out_frames) continue;
      const float w = window[static_cast<size_t>(i)];
      const float srcPos = srcStart + static_cast<float>(i);
      for (int ch = 0; ch < channels; ++ch) {
        const float* inCh = input + static_cast<size_t>(ch) * static_cast<size_t>(in_frames);
        float* outCh = output + static_cast<size_t>(ch) * static_cast<size_t>(out_frames);
        outCh[outIdx] += sampleAt(inCh, in_frames, srcPos) * w;
      }
      norm[static_cast<size_t>(outIdx)] += w;
    }
  }

  for (int i = 0; i < out_frames; ++i) {
    const float n = norm[static_cast<size_t>(i)];
    if (n > 1e-6f) {
      for (int ch = 0; ch < channels; ++ch) {
        float* outCh = output + static_cast<size_t>(ch) * static_cast<size_t>(out_frames);
        outCh[i] /= n;
      }
    }
  }

  return 0;
}

}  // namespace

extern "C" int time_stretch_remap(
    const float* input,
    int in_frames,
    int channels,
    const float* source_offsets,
    int num_offsets,
    int hop,
    float* output,
    int out_frames) {
  return remapImpl(
      input, in_frames, channels, source_offsets, num_offsets, hop, output, out_frames);
}

extern "C" int time_stretch_constant(
    const float* input,
    int in_frames,
    int channels,
    float tempo,
    float* output,
    int out_frames,
    int hop) {
  if (!input || !output || in_frames <= 0 || out_frames <= 0 || channels <= 0) return 1;
  const float rate = std::max(0.05f, tempo);
  hop = clampHop(hop);
  const int numHops = std::max(1, (out_frames + hop - 1) / hop + 1);
  std::vector<float> offsets(static_cast<size_t>(numHops));
  for (int h = 0; h < numHops; ++h) {
    offsets[static_cast<size_t>(h)] =
        static_cast<float>(h) * static_cast<float>(hop) * rate;
  }
  return remapImpl(
      input, in_frames, channels, offsets.data(), numHops, hop, output, out_frames);
}
