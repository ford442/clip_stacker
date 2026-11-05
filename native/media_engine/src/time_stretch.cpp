#include "time_stretch.h"

#include "cs_alloc.h"
#include "cs_math.h"
#include "cs_status.h"
#include "resampler.h"

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstddef>
#include <new>

namespace {

using media_engine::SourceSlice;

constexpr int kMinHop = 64;
constexpr int kMaxHop = 4096;
constexpr int kMaxChannels = 8;
/**
 * The lag search first scores every `kCoarseStep`-th lag on every
 * `kCoarseStep`-th sample, then rescores the neighbours of the coarse winner
 * at full resolution. Lag 0 is always on the coarse grid.
 */
constexpr int kCoarseStep = 4;
/** Segment starts this close to a whole frame are copied, not interpolated. */
constexpr double kIntegralEpsilon = 1e-6;

/**
 * The source as one call sees it: `frames` is the whole source's length;
 * `planes` hold a window of it (`first_frame` / `frame_count`, the same for
 * every channel), which a chunked session moves forward call by call.
 */
struct Source {
  SourceSlice planes[kMaxChannels];
  int channels = 0;
  int frames = 0;
  const float* sinc_rows = nullptr;
};

/** The source may not be longer than this, so every segment's frame arithmetic stays in int. */
constexpr long long kMaxSourceFrames = INT_MAX - 8LL * kMaxHop;

/** One synthesis segment: source frames `[start, start + 2 * hop)`. */
struct Segment {
  double start = 0.0;
  int base = 0;
  /** `start` is a whole frame: read by copy (bit-exact), not through the FIR. */
  bool integral = true;
  alignas(16) float coeff[media_engine::kSincTaps];
};

/**
 * Position a segment. Starts are clamped to a band just outside the input:
 * every read beyond it is silence either way, and the clamp keeps frame
 * arithmetic inside int range.
 */
void place(Segment& seg, double start, const Source& src) {
  const double margin = 4.0 * kMaxHop;
  start = std::max(-margin, std::min(static_cast<double>(src.frames) + margin, start));
  const double nearest = std::floor(start + 0.5);
  if (std::fabs(start - nearest) < kIntegralEpsilon) {
    seg.start = nearest;
    seg.base = static_cast<int>(nearest);
    seg.integral = true;
  } else {
    seg.start = start;
    seg.base = media_engine::sinc_prepare(src.sinc_rows, start, seg.coeff);
    seg.integral = false;
  }
}

/** Sample `i` of the segment, one channel. */
float read(const Source& src, const Segment& seg, int channel, int i) {
  const SourceSlice& plane = src.planes[channel];
  if (seg.integral) return media_engine::slice_sample(plane, seg.base + i);
  return media_engine::sinc_read(plane, seg.base + i, seg.coeff);
}

/** All channels summed at one whole frame (silence outside the input). */
float mono_at(const Source& src, long long frame) {
  const long long local = frame - src.planes[0].first_frame;
  if (local < 0 || local >= src.planes[0].frame_count) return 0.f;
  float sum = 0.f;
  for (int c = 0; c < src.channels; ++c) sum += src.planes[c].data[local];
  return sum;
}

/**
 * Normalized cross-correlation of `target` with the source from `base`, on
 * every `step`-th sample. Dividing by the candidate's energy only (the
 * target's is the same for every lag) keeps loud passages from winning just
 * for being loud.
 */
double similarity(const Source& src, const float* target, int len, long long base, int step) {
  double corr = 0.0;
  double energy = 0.0;
  for (int n = 0; n < len; n += step) {
    const double x = static_cast<double>(mono_at(src, base + n));
    corr += static_cast<double>(target[n]) * x;
    energy += x * x;
  }
  return energy > 0.0 ? corr / std::sqrt(energy) : 0.0;
}

/** Lag in [-tolerance, tolerance] whose source best continues `target`; ties keep the smaller |lag|. */
int best_lag(const Source& src, const float* target, int len, long long nominal, int tolerance) {
  int best = 0;
  double best_score = similarity(src, target, len, nominal, kCoarseStep);
  for (int d = kCoarseStep; d <= tolerance; d += kCoarseStep) {
    for (const int lag : {-d, d}) {
      const double score = similarity(src, target, len, nominal + lag, kCoarseStep);
      if (score > best_score) {
        best_score = score;
        best = lag;
      }
    }
  }
  const int centre = best;
  best_score = similarity(src, target, len, nominal + centre, 1);
  for (int d = 1; d < kCoarseStep; ++d) {
    for (const int lag : {centre - d, centre + d}) {
      if (lag < -tolerance || lag > tolerance) continue;
      const double score = similarity(src, target, len, nominal + lag, 1);
      if (score > best_score) {
        best_score = score;
        best = lag;
      }
    }
  }
  return best;
}

/**
 * WSOLA state across calls: the segment whose falling half the next output
 * block starts with. Output block b = [b * hop, (b + 1) * hop) is the falling
 * half of segment b crossfaded into the rising half of segment b + 1.
 */
struct Stretcher {
  int channels = 0;
  int hop = 0;
  int tolerance = 0;
  int source_frames = 0;
  const float* sinc_rows = nullptr;
  cs::Buffer<float> fade;
  cs::Buffer<float> target;
  Segment current;
  bool started = false;
  /** The curve ran out: everything from here on is silence. */
  bool exhausted = false;
  /** A short (final) chunk was produced; the session takes no more input. */
  bool finished = false;

  /** CS_OK or CS_ENOMEM. */
  int init(int source_length, int channel_count, int hop_frames, int search) {
    channels = channel_count;
    source_frames = source_length;
    hop = std::max(kMinHop, std::min(kMaxHop, hop_frames));
    tolerance = search < 0 ? hop / 2 : std::min(search, hop);
    if (!fade.allocate(static_cast<size_t>(hop)) || !target.allocate(static_cast<size_t>(hop))) return CS_ENOMEM;
    // fade[n]: weight of the incoming segment over one overlap. Periodic Hann
    // at 50% overlap sums to one, so this is the window's rising half; the
    // division only removes rounding.
    for (int n = 0; n < hop; ++n) {
      const double rise = 0.5 - 0.5 * std::cos(cs::kPi * n / hop);
      const double fall = 0.5 - 0.5 * std::cos(cs::kPi * (n + hop) / hop);
      fade[static_cast<size_t>(n)] = static_cast<float>(rise / (rise + fall));
    }
    sinc_rows = media_engine::sinc_table(media_engine::sinc_cutoff_for_step(1.0));
    return CS_OK;
  }

  /** Every read this chunk can make lies in the window (or outside the source). */
  bool covers(const Source& src, const double* offsets, int count) const {
    if (count <= 0) return true;
    double lo = offsets[0];
    double hi = offsets[0];
    for (int i = 1; i < count; ++i) {
      lo = std::min(lo, offsets[i]);
      hi = std::max(hi, offsets[i]);
    }
    const double margin = 2.0 * hop + tolerance + media_engine::kSincTaps;
    lo = std::max(0.0, lo - margin);
    hi = std::min(static_cast<double>(source_frames), hi + margin);
    if (lo >= hi) return true;
    const double first = src.planes[0].first_frame;
    return lo >= first && hi <= first + src.planes[0].frame_count;
  }

  int process(const Source& src, const double* offsets, int num_offsets, float* output, int out_frames) {
    if (finished) return CS_ESTATE;
    for (int h = 0; h < num_offsets; ++h) {
      if (!std::isfinite(offsets[h])) return CS_EINVAL;
    }
    const long long blocks = (static_cast<long long>(out_frames) + hop - 1) / hop;
    const long long segments = exhausted ? 0 : std::min(static_cast<long long>(num_offsets), blocks + 1);
    if (!covers(src, offsets, static_cast<int>(segments))) return CS_ERANGE;
    if (out_frames % hop != 0) finished = true;

    if (!started && segments > 0) {
      place(current, offsets[0] - hop, src);
      started = true;
    }

    for (long long b = 0; b < blocks; ++b) {
      const long long begin = b * hop;
      const int count = static_cast<int>(std::min(static_cast<long long>(hop), out_frames - begin));
      if (b >= segments) {
        for (int c = 0; c < channels; ++c) {
          float* plane = output + static_cast<size_t>(c) * static_cast<size_t>(out_frames);
          std::fill(plane + begin, plane + out_frames, 0.f);
        }
        exhausted = true;
        break;
      }

      const bool has_next = b + 1 < segments;
      Segment next;
      if (has_next) {
        const double nominal = offsets[b + 1] - hop;
        const double natural = current.start + hop;
        int lag = 0;
        // Already the natural continuation (rate 1): nothing to search for.
        if (tolerance > 0 && std::fabs(nominal - natural) >= kIntegralEpsilon) {
          const long long target_base = std::llround(natural);
          double target_energy = 0.0;
          for (int n = 0; n < hop; ++n) {
            const float x = mono_at(src, target_base + n);
            target[static_cast<size_t>(n)] = x;
            target_energy += static_cast<double>(x) * static_cast<double>(x);
          }
          if (target_energy > 0.0) lag = best_lag(src, target.data(), hop, std::llround(nominal), tolerance);
        }
        place(next, nominal + lag, src);
      }

      for (int c = 0; c < channels; ++c) {
        float* out = output + static_cast<size_t>(c) * static_cast<size_t>(out_frames) + begin;
        for (int n = 0; n < count; ++n) {
          const float falling = read(src, current, c, hop + n);
          // a + (b - a) * g, not a * (1 - g) + b * g: equal inputs come back exact.
          out[n] = has_next ? falling + (read(src, next, c, n) - falling) * fade[static_cast<size_t>(n)] : falling;
        }
      }
      if (has_next) {
        current = next;
      } else {
        // The last segment's falling half is spent: the rest is silence.
        exhausted = true;
      }
    }
    return CS_OK;
  }
};

/** `window` planar, `frames` per channel, holding source frames from `first`. */
Source window_source(const Stretcher& st, const float* window, int frames, int first) {
  Source src;
  src.channels = st.channels;
  src.frames = st.source_frames;
  src.sinc_rows = st.sinc_rows;
  for (int c = 0; c < st.channels; ++c) {
    src.planes[c] = SourceSlice{window + static_cast<size_t>(c) * static_cast<size_t>(frames), first, frames};
  }
  return src;
}

bool valid_source_length(double frames) {
  return std::isfinite(frames) && frames >= 1.0 && frames <= static_cast<double>(kMaxSourceFrames) &&
         frames == std::floor(frames);
}

}  // namespace

extern "C" int time_stretch_remap(
    const float* input,
    int in_frames,
    int channels,
    const double* source_offsets,
    int num_offsets,
    int hop,
    int tolerance,
    float* output,
    int out_frames) {
  if (!input || !output || !source_offsets) return CS_EINVAL;
  if (in_frames <= 0 || out_frames <= 0 || num_offsets <= 0) return CS_EINVAL;
  if (channels < 1 || channels > kMaxChannels) return CS_EINVAL;
  if (!valid_source_length(in_frames)) return CS_EINVAL;
  Stretcher st;
  const int rc = st.init(in_frames, channels, hop, tolerance);
  if (rc != CS_OK) return rc;
  // One call over the whole input: the chunked path with a single chunk.
  return st.process(window_source(st, input, in_frames, 0), source_offsets, num_offsets, output, out_frames);
}

extern "C" void* time_stretch_session_create(double source_frames, int channels, int hop, int tolerance) {
  if (!valid_source_length(source_frames) || channels < 1 || channels > kMaxChannels) return nullptr;
  Stretcher* st = new (std::nothrow) Stretcher();
  if (!st) return nullptr;
  if (st->init(static_cast<int>(source_frames), channels, hop, tolerance) != CS_OK) {
    delete st;
    return nullptr;
  }
  return st;
}

extern "C" int time_stretch_session_process(
    void* session,
    const float* window,
    int window_frames,
    double window_start,
    const double* offsets,
    int num_offsets,
    float* output,
    int out_frames) {
  if (!session || !output || out_frames <= 0 || num_offsets < 0) return CS_EINVAL;
  if (num_offsets > 0 && !offsets) return CS_EINVAL;
  if (window_frames < 0 || (window_frames > 0 && !window)) return CS_EINVAL;
  Stretcher* st = static_cast<Stretcher*>(session);
  if (!std::isfinite(window_start) || window_start != std::floor(window_start) || window_start < 0.0 ||
      window_start + window_frames > static_cast<double>(st->source_frames)) {
    return CS_EINVAL;
  }
  const int first = static_cast<int>(window_start);
  static const float kEmpty[1] = {0.f};
  const Source src = window_source(*st, window_frames > 0 ? window : kEmpty, window_frames, first);
  return st->process(src, offsets, num_offsets, output, out_frames);
}

extern "C" int time_stretch_session_hop(const void* session) {
  return session ? static_cast<const Stretcher*>(session)->hop : 0;
}

extern "C" void time_stretch_session_destroy(void* session) {
  delete static_cast<Stretcher*>(session);
}
