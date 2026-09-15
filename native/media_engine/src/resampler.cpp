#include "resampler.h"

void resample_linear_stereo(
    const float* interleaved,
    int frames,
    int channels,
    float src_frame,
    float* out_l,
    float* out_r) {
  *out_l = 0.f;
  *out_r = 0.f;
  if (!interleaved || frames <= 0 || channels < 1) return;
  if (src_frame < 0.f) return;

  const int ch = channels >= 2 ? 2 : 1;
  const int last = frames - 1;
  if (src_frame >= static_cast<float>(last)) {
    if (src_frame > static_cast<float>(last) + 1e-4f) return;
    const int base = last * ch;
    *out_l = interleaved[base];
    *out_r = ch == 2 ? interleaved[base + 1] : interleaved[base];
    return;
  }

  const int i0 = static_cast<int>(src_frame);
  const int i1 = i0 + 1;
  const float t = src_frame - static_cast<float>(i0);
  const int b0 = i0 * ch;
  const int b1 = i1 * ch;
  const float l0 = interleaved[b0];
  const float r0 = ch == 2 ? interleaved[b0 + 1] : l0;
  const float l1 = interleaved[b1];
  const float r1 = ch == 2 ? interleaved[b1 + 1] : l1;
  *out_l = l0 + (l1 - l0) * t;
  *out_r = r0 + (r1 - r0) * t;
}
