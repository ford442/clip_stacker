#include "audio_mix.h"
#include "resampler.h"

#include <algorithm>
#include <cmath>

namespace {

using media_engine::SourceSlice;

constexpr double kPi = 3.14159265358979323846;

double fade_gain(double local_time, double duration, double fade_in, double fade_out) {
  double gain = 1.0;
  if (fade_in > 0.0 && local_time < fade_in) {
    gain *= local_time / fade_in;
  }
  if (fade_out > 0.0 && local_time > duration - fade_out) {
    const double remaining = duration - local_time;
    const double out_progress = remaining / fade_out;
    gain *= std::max(0.0, std::min(1.0, out_progress));
  }
  return gain;
}

// Same Newton solve (and operation order) as `cubicBezier` in keyframes.ts.
double cubic_bezier(double u, double x1, double y1, double x2, double y2) {
  const double target_x = std::max(0.0, std::min(1.0, u));
  if (target_x <= 0.0) return 0.0;
  if (target_x >= 1.0) return 1.0;

  double t = target_x;
  for (int i = 0; i < 8; ++i) {
    const double x = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t - target_x;
    const double dx = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (std::fabs(dx) < 1e-6) break;
    t -= x / dx;
    t = std::max(0.0, std::min(1.0, t));
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
}

double apply_easing(double u, const double* key) {
  const double clamped = std::max(0.0, std::min(1.0, u));
  // Compared as doubles: an unknown (even NaN) code falls through to bezier,
  // like `applyEasing`, with no float -> int conversion.
  const double easing = key[MIX_KEY_EASING];
  if (easing == MIX_EASING_LINEAR) return clamped;
  if (easing == MIX_EASING_BELL_SMOOTH) return std::sin(clamped * kPi);
  if (easing == MIX_EASING_BELL_SHARP) {
    const double fold = clamped < 0.5 ? 2 * clamped : 2 * (1 - clamped);
    return fold == 0.0 ? 0.0 : std::pow(2.0, 10 * fold - 10);
  }
  return cubic_bezier(clamped, key[MIX_KEY_X1], key[MIX_KEY_Y1], key[MIX_KEY_X2], key[MIX_KEY_Y2]);
}

/**
 * `sampleKeyframes` over a sorted packed curve. The segment cursor only moves
 * forward, so callers must sample with non-decreasing `t`.
 */
class Curve {
 public:
  Curve(const double* keys, int count) : keys_(keys), count_(count) {}

  bool empty() const { return count_ == 0; }

  double sample(double t) {
    if (count_ == 1 || t <= key(0)[MIX_KEY_TIME]) return key(0)[MIX_KEY_VALUE];
    while (seg_ < count_ - 2 && t > key(seg_ + 1)[MIX_KEY_TIME]) ++seg_;
    const double* a = key(seg_);
    const double* b = key(seg_ + 1);
    if (t <= b[MIX_KEY_TIME]) {
      const double span = b[MIX_KEY_TIME] - a[MIX_KEY_TIME];
      if (span <= 0.0) return b[MIX_KEY_VALUE];
      const double raw_u = (t - a[MIX_KEY_TIME]) / span;
      return a[MIX_KEY_VALUE] + (b[MIX_KEY_VALUE] - a[MIX_KEY_VALUE]) * apply_easing(raw_u, a);
    }
    // Past the last keyframe: hold the last segment's eased end value.
    return a[MIX_KEY_VALUE] + (b[MIX_KEY_VALUE] - a[MIX_KEY_VALUE]) * apply_easing(1.0, a);
  }

 private:
  const double* key(int i) const { return keys_ + i * MIX_KEY_STRIDE; }

  const double* keys_;
  int count_;
  int seg_ = 0;
};

/**
 * `StereoPannerNode` equal-power law (Web Audio spec §1.31.1), so WASM premix
 * matches preview and the OfflineAudioContext graph — including the -3 dB a
 * mono source gets at centre pan.
 */
class Panner {
 public:
  explicit Panner(bool mono) : mono_(mono) { set(0.0); }

  void apply(double pan, const float* in, float* l, float* r) {
    if (pan != pan_) set(pan);
    if (mono_) {
      *l = in[0] * gain_l_;
      *r = in[0] * gain_r_;
    } else if (pan_ == 0.0) {
      *l = in[0];
      *r = in[1];
    } else if (pan_ < 0.0) {
      *l = in[0] + in[1] * gain_l_;
      *r = in[1] * gain_r_;
    } else {
      *l = in[0] * gain_l_;
      *r = in[1] + in[0] * gain_r_;
    }
  }

 private:
  void set(double pan) {
    pan_ = pan;
    const double x = mono_ ? (pan + 1.0) * 0.5 : (pan <= 0.0 ? pan + 1.0 : pan);
    gain_l_ = static_cast<float>(std::cos(x * kPi * 0.5));
    gain_r_ = static_cast<float>(std::sin(x * kPi * 0.5));
  }

  bool mono_;
  double pan_ = 0.0;
  float gain_l_ = 0.f;
  float gain_r_ = 0.f;
};

bool valid_key_range(double first, double count, int keyframe_count) {
  if (!(first >= 0.0) || !(count >= 0.0)) return false;
  return first + count <= static_cast<double>(keyframe_count);
}

enum class Interp { kCopy, kSinc, kLinear };

}  // namespace

int mix_timeline_audio_range(
    float* out,
    int out_frames,
    int start_frame,
    int out_sample_rate,
    int out_channels,
    const float* pcm_blob,
    const int* slices,
    int slice_count,
    const double* entries,
    int entry_count,
    const double* keyframes,
    int keyframe_count,
    int flags) {
  if (!out || out_frames <= 0 || start_frame < 0 || out_sample_rate <= 0) return -1;
  if (out_channels != 1 && out_channels != 2) return -1;
  if (slice_count < 0 || entry_count < 0 || keyframe_count < 0) return -1;
  if (slice_count > 0 && (!pcm_blob || !slices)) return -1;
  if (entry_count > 0 && !entries) return -1;
  if (keyframe_count > 0 && !keyframes) return -1;

  const int out_ch = out_channels;
  const int out_samples = out_frames * out_ch;
  for (int i = 0; i < out_samples; ++i) out[i] = 0.f;

  const double out_rate = static_cast<double>(out_sample_rate);
  const double chunk_begin = static_cast<double>(start_frame);
  const double chunk_end = chunk_begin + static_cast<double>(out_frames);

  for (int e = 0; e < entry_count; ++e) {
    const double* row = entries + e * MIX_ENTRY_STRIDE;
    const double slice_index = row[MIX_ENTRY_SLICE_INDEX];
    if (!(slice_index >= 0.0 && slice_index < static_cast<double>(slice_count))) continue;

    const double vol_first = row[MIX_ENTRY_VOLUME_KEYS];
    const double vol_count = row[MIX_ENTRY_VOLUME_KEY_COUNT];
    const double pan_first = row[MIX_ENTRY_PAN_KEYS];
    const double pan_count = row[MIX_ENTRY_PAN_KEY_COUNT];
    if (!valid_key_range(vol_first, vol_count, keyframe_count) ||
        !valid_key_range(pan_first, pan_count, keyframe_count)) {
      return -2;
    }

    const int* meta = slices + static_cast<int>(slice_index) * MIX_SLICE_STRIDE;
    const int pcm_offset = meta[MIX_SLICE_PCM_OFFSET];
    const int slice_frames = meta[MIX_SLICE_FRAMES];
    const int src_ch = meta[MIX_SLICE_CHANNELS];
    const int src_rate = meta[MIX_SLICE_SAMPLE_RATE];
    const int first_frame = meta[MIX_SLICE_FIRST_FRAME];
    const int clip_frames = meta[MIX_SLICE_CLIP_FRAMES];
    if (clip_frames <= 0 || src_rate <= 0 || src_ch < 1 || pcm_offset < 0 || slice_frames < 0) continue;

    const double timeline_start = row[MIX_ENTRY_TIMELINE_START];
    const double duration = row[MIX_ENTRY_DURATION];
    const double buffer_offset = std::max(0.0, row[MIX_ENTRY_BUFFER_OFFSET]);
    const double volume = row[MIX_ENTRY_VOLUME];
    const double fade_in = std::max(0.0, row[MIX_ENTRY_FADE_IN]);
    const double fade_out = std::max(0.0, row[MIX_ENTRY_FADE_OUT]);
    double playback_rate = row[MIX_ENTRY_PLAYBACK_RATE];
    if (!(playback_rate > 0.0) || !std::isfinite(playback_rate)) playback_rate = 1.0;
    if (!(duration > 0.0) || !std::isfinite(duration)) continue;
    if (!std::isfinite(timeline_start) || !std::isfinite(volume)) continue;

    const double first_of = std::max(chunk_begin, std::floor(timeline_start * out_rate));
    const double end_of = std::min(chunk_end, std::ceil((timeline_start + duration) * out_rate) + 1.0);
    if (!(first_of < end_of)) continue;

    const int planes = src_ch >= 2 ? 2 : 1;
    SourceSlice source[2];
    for (int c = 0; c < planes; ++c) {
      source[c] = SourceSlice{pcm_blob + pcm_offset + c * slice_frames, first_frame, slice_frames};
    }

    const double src_rate_d = static_cast<double>(src_rate);
    const double step = playback_rate * src_rate_d / out_rate;
    Interp interp = Interp::kSinc;
    const float* sinc_rows = nullptr;
    double copy_offset = 0.0;
    if (step == 1.0) {
      // Same-rate: integer frame copy (bit-exact); a sub-sample start offset
      // snaps to the nearest source frame instead of low-passing every sample.
      interp = Interp::kCopy;
      copy_offset = std::floor(buffer_offset * src_rate_d - timeline_start * out_rate + 0.5);
    } else if (flags & MIX_FLAG_LINEAR_RESAMPLE) {
      interp = Interp::kLinear;
    } else {
      sinc_rows = media_engine::sinc_table(media_engine::sinc_cutoff_for_step(step));
    }

    Curve volume_curve(keyframes + static_cast<int>(vol_first) * MIX_KEY_STRIDE, static_cast<int>(vol_count));
    Curve pan_curve(keyframes + static_cast<int>(pan_first) * MIX_KEY_STRIDE, static_cast<int>(pan_count));
    Panner panner(planes == 1);

    const long long of_begin = static_cast<long long>(first_of);
    const long long of_end = static_cast<long long>(end_of);
    for (long long of = of_begin; of < of_end; ++of) {
      const double local = static_cast<double>(of) / out_rate - timeline_start;
      if (local < 0.0 || local >= duration) continue;

      double level = fade_gain(local, duration, fade_in, fade_out);
      if (volume_curve.empty()) {
        level *= volume;
      } else {
        // applyGainEnvelope: absolute keyframe gain × fades, then clampClipVolume.
        level = std::max(0.0, std::min(static_cast<double>(MIX_VOLUME_MAX), volume_curve.sample(local) * level));
      }
      if (level == 0.0) continue;
      const double pan =
          pan_curve.empty() ? 0.0 : std::max(-1.0, std::min(1.0, pan_curve.sample(local)));

      float in[2] = {0.f, 0.f};
      if (interp == Interp::kCopy) {
        const double src = static_cast<double>(of) + copy_offset;
        if (src < 0.0 || src >= static_cast<double>(clip_frames)) continue;
        const int frame = static_cast<int>(src);
        for (int c = 0; c < planes; ++c) in[c] = media_engine::slice_sample(source[c], frame);
      } else {
        const double pos = (buffer_offset + local * playback_rate) * src_rate_d;
        if (!(pos >= 0.0) || pos >= static_cast<double>(clip_frames)) continue;
        if (interp == Interp::kLinear) {
          media_engine::resample_linear(source, planes, pos, clip_frames, in);
        } else {
          media_engine::resample_sinc(source, planes, pos, sinc_rows, in);
        }
      }

      float l = 0.f;
      float r = 0.f;
      panner.apply(pan, in, &l, &r);
      const float gain = static_cast<float>(level);
      const long long base = (of - start_frame) * out_ch;
      if (out_ch == 1) {
        out[base] += 0.5f * (l + r) * gain;
      } else {
        out[base] += l * gain;
        out[base + 1] += r * gain;
      }
    }
  }

  return 0;
}

int mix_timeline_audio(
    float* out,
    int out_frames,
    int out_sample_rate,
    int out_channels,
    const float* pcm_blob,
    const int* slices,
    int slice_count,
    const double* entries,
    int entry_count,
    const double* keyframes,
    int keyframe_count,
    int flags) {
  return mix_timeline_audio_range(
      out, out_frames, 0, out_sample_rate, out_channels, pcm_blob, slices, slice_count,
      entries, entry_count, keyframes, keyframe_count, flags);
}
