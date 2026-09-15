#include "audio_mix.h"
#include "resampler.h"

#include <algorithm>
#include <cmath>

namespace {

float fade_gain(float local_time, float duration, float fade_in, float fade_out) {
  float gain = 1.f;
  if (fade_in > 0.f && local_time < fade_in) {
    gain *= local_time / fade_in;
  }
  if (fade_out > 0.f && local_time > duration - fade_out) {
    const float remaining = duration - local_time;
    const float out_progress = remaining / fade_out;
    gain *= std::max(0.f, std::min(1.f, out_progress));
  }
  return gain;
}

}  // namespace

int mix_timeline_audio(
    float* out,
    int out_frames,
    int out_sample_rate,
    int out_channels,
    const float* pcm_blob,
    const int* clip_meta,
    int clip_count,
    const float* entries,
    int entry_count) {
  if (!out || out_frames <= 0 || out_sample_rate <= 0) return -1;
  if (out_channels != 1 && out_channels != 2) return -1;
  if (clip_count < 0 || entry_count < 0) return -1;
  if (clip_count > 0 && (!pcm_blob || !clip_meta)) return -1;
  if (entry_count > 0 && !entries) return -1;

  const int out_ch = out_channels;
  const int out_samples = out_frames * out_ch;
  for (int i = 0; i < out_samples; ++i) out[i] = 0.f;

  const float inv_out_rate = 1.f / static_cast<float>(out_sample_rate);

  for (int e = 0; e < entry_count; ++e) {
    const float* row = entries + e * MIX_ENTRY_STRIDE;
    const int clip_index = static_cast<int>(row[MIX_ENTRY_CLIP_INDEX]);
    if (clip_index < 0 || clip_index >= clip_count) continue;

    const int* meta = clip_meta + clip_index * MIX_CLIP_STRIDE;
    const int pcm_offset = meta[MIX_CLIP_PCM_OFFSET];
    const int src_frames = meta[MIX_CLIP_FRAMES];
    const int src_ch = meta[MIX_CLIP_CHANNELS];
    const int src_rate = meta[MIX_CLIP_SAMPLE_RATE];
    if (src_frames <= 0 || src_rate <= 0 || src_ch < 1 || pcm_offset < 0) continue;

    const float timeline_start = row[MIX_ENTRY_TIMELINE_START];
    const float duration = row[MIX_ENTRY_DURATION];
    const float buffer_offset = std::max(0.f, row[MIX_ENTRY_BUFFER_OFFSET]);
    const float volume = row[MIX_ENTRY_VOLUME];
    const float fade_in = std::max(0.f, row[MIX_ENTRY_FADE_IN]);
    const float fade_out = std::max(0.f, row[MIX_ENTRY_FADE_OUT]);
    float playback_rate = row[MIX_ENTRY_PLAYBACK_RATE];
    if (!(playback_rate > 0.f) || !std::isfinite(playback_rate)) playback_rate = 1.f;
    if (!(duration > 0.f) || !std::isfinite(duration)) continue;
    if (!std::isfinite(timeline_start) || !std::isfinite(volume)) continue;

    const float* pcm = pcm_blob + pcm_offset;
    const float src_rate_f = static_cast<float>(src_rate);

    const int start_frame = std::max(
        0, static_cast<int>(std::floor(timeline_start * static_cast<float>(out_sample_rate))));
    const int end_frame = std::min(
        out_frames,
        static_cast<int>(std::ceil((timeline_start + duration) * static_cast<float>(out_sample_rate))));

    for (int of = start_frame; of < end_frame; ++of) {
      const float t = static_cast<float>(of) * inv_out_rate;
      const float local = t - timeline_start;
      if (local < 0.f || local >= duration) continue;

      const float gain = volume * fade_gain(local, duration, fade_in, fade_out);
      if (gain == 0.f) continue;

      const float src_time = buffer_offset + local * playback_rate;
      const float src_frame = src_time * src_rate_f;
      float sl = 0.f;
      float sr = 0.f;
      resample_linear_stereo(pcm, src_frames, src_ch, src_frame, &sl, &sr);

      const int base = of * out_ch;
      if (out_ch == 1) {
        out[base] += 0.5f * (sl + sr) * gain;
      } else {
        out[base] += sl * gain;
        out[base + 1] += sr * gain;
      }
    }
  }

  return 0;
}
