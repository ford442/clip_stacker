#pragma once

// Lane buses and the master bus: the stage after the per-clip mix. Internal
// C++ API behind `mix_bus_session_create` (export) and `bus_graph_*` (the
// preview's AudioWorklet), so both run this one implementation.
//
//   lane input -> lane chain -> delay compensation -> sidechain duck --+
//   lane input -> ...                                                  +-> sum
//   direct (unrouted) input -> delay compensation ---------------------+
//   sum -> master chain -> output gain -> final limiter -> [meter] -> out
//
// Lanes are processed in packed order, one frame at a time, so a ducker can
// key off any lane packed before it (already processed for that frame).
// Delay compensation pads every lane to the slowest lane chain, so lanes stay
// sample-aligned with each other and with their keys.

#include "effects.h"
#include "loudness.h"

#include <vector>

namespace media_engine {

/** An ordered chain of bus stages built from packed `MIX_FX_*` rows. */
class BusChain {
 public:
  /**
   * Build from `count` rows (disabled and unknown rows dropped). Ducker rows
   * are not stages: the first enabled one is returned through `ducker` (null
   * when none). `limiters_only` keeps nothing but limiters (the final stage).
   * False on OOM.
   */
  bool build(const double* rows, int count, double sample_rate, int channels, bool limiters_only,
             const double** ducker);

  /** True when `rows` would build the same stage sequence (and latency). */
  bool matches(const double* rows, int count, const double** ducker) const;

  /** Retune in place; false (nothing changed) when the rows' structure differs. */
  bool retune(const double* rows, int count, const double** ducker);

  bool empty() const { return order_.empty(); }
  int latency() const { return latency_; }
  void reset();

  /** One frame in place, delayed by `latency()` frames. */
  void process(float* frame);

  /** Sum of the stages' current gain reduction (dB, >= 0). */
  double reduction_db() const;

 private:
  enum Kind : int { kBiquad, kCompressor, kGate, kDeEsser, kLimiter };
  struct Stage {
    Kind kind;
    int index;
  };
  /** Kind sequence plus limiter look-aheads: what `retune` must match. */
  bool signature(const double* rows, int count, std::vector<long long>* out, const double** ducker) const;

  double sample_rate_ = 48000;
  int channels_ = 2;
  bool limiters_only_ = false;
  int latency_ = 0;
  std::vector<Stage> order_;
  std::vector<long long> signature_;
  std::vector<Biquad> biquads_;
  std::vector<Compressor> compressors_;
  std::vector<Gate> gates_;
  std::vector<DeEsser> deessers_;
  std::vector<Limiter> limiters_;
};

struct BusLayout {
  const double* effects = nullptr;
  int effect_count = 0;
  const int* buses = nullptr;
  int bus_count = 0;
  int master_first = 0;
  int master_count = 0;
  double output_gain_db = 0;
  int final_first = 0;
  int final_count = 0;
};

class BusGraph {
 public:
  /** `cs_status`. */
  int build(double sample_rate, int channels, const BusLayout& layout, int flags);
  /** CS_OK, or CS_ESTATE when the structure changed (nothing was touched). */
  int retune(const BusLayout& layout);

  /** False when the graph would pass its input straight through (no stage, duck, gain or meter). */
  bool active() const { return active_; }
  int latency() const { return latency_; }
  int lane_count() const { return static_cast<int>(lanes_.size()) - 1; }
  int channels() const { return channels_; }
  bool metering() const { return meter_on_; }

  /** See `bus_graph_process`: `bus_count + 1` lane-major interleaved blocks in, one block out. */
  void process(const float* lanes, float* out, int frames);

  /** `MIX_METER_*` layout; returns the count written. Gain-reduction peaks restart. */
  int meters(double* out, int capacity);
  void reset_meter();
  /** Clear processing state (a seek); the meter keeps its measurement. */
  void reset();

 private:
  struct Lane {
    BusChain chain;
    std::vector<float> pdc;
    int pdc_frames = 0;
    int pdc_pos = 0;
    bool has_duck = false;
    Ducker duck;
    int key = -1;
    double gr_peak = 0;
  };
  static bool valid_range(int first, int count, int effect_count);
  int validate(const BusLayout& layout) const;

  double sample_rate_ = 48000;
  int channels_ = 2;
  bool active_ = false;
  bool meter_on_ = false;
  int lane_latency_ = 0;
  int latency_ = 0;
  long long processed_ = 0;
  float output_gain_ = 1.f;
  std::vector<Lane> lanes_;
  std::vector<float> lane_out_;
  BusChain master_;
  BusChain final_;
  double master_gr_peak_ = 0;
  LoudnessMeter meter_;
};

}  // namespace media_engine
