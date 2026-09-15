#include "resampler.h"

void resample_linear_stereo(
    const float* interleaved,
    int frames,
    int channels,
    double src_frame,
    float* out_l,
    float* out_r) {
  *out_l = 0.f;
  *out_r = 0.f;
  if (!interleaved || frames <= 0 || channels < 1) return;
  if (!(src_frame >= 0.0) || src_frame >= static_cast<double>(frames)) return;

  const int ch = channels >= 2 ? 2 : 1;
  const int last = frames - 1;
  const int i0 = static_cast<int>(src_frame);
  const int i1 = i0 < last ? i0 + 1 : last;
  const float t = static_cast<float>(src_frame - static_cast<double>(i0));
  const int b0 = i0 * ch;
  const int b1 = i1 * ch;
  const float l0 = interleaved[b0];
  const float r0 = ch == 2 ? interleaved[b0 + 1] : l0;
  const float l1 = interleaved[b1];
  const float r1 = ch == 2 ? interleaved[b1 + 1] : l1;
  *out_l = l0 + (l1 - l0) * t;
  *out_r = r0 + (r1 - r0) * t;
}

