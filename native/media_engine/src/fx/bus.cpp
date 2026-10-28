// Lane buses, master bus and their C API (`bus_graph_*`, `loudness_meter_*`).
// See bus.h for the signal flow.

#include "bus.h"

#include "audio_mix.h"
#include "cs_alloc.h"
#include "cs_status.h"

#include <algorithm>
#include <cmath>
#include <new>

namespace media_engine {

namespace {

bool is_eq_kind(double kind) {
  return kind == MIX_FX_PEAKING || kind == MIX_FX_LOW_SHELF || kind == MIX_FX_HIGH_SHELF ||
         kind == MIX_FX_HIGH_PASS || kind == MIX_FX_LOW_PASS;
}

float frame_peak(const float* frame, int channels) {
  float peak = std::fabs(frame[0]);
  if (channels > 1) peak = std::max(peak, std::fabs(frame[1]));
  return peak;
}

double gain_to_reduction_db(float gain) {
  return gain < 1.f && gain > 0.f ? -20.0 * std::log10(static_cast<double>(gain)) : 0.0;
}

}  // namespace

// ---------------------------------------------------------------------------
// BusChain

bool BusChain::signature(const double* rows, int count, std::vector<long long>* out,
                         const double** ducker) const {
  out->clear();
  if (ducker) *ducker = nullptr;
  int stages = 0;
  for (int i = 0; i < count; ++i) {
    const double* row = rows + static_cast<size_t>(i) * MIX_FX_STRIDE;
    if (row[MIX_FX_ENABLED] == 0.0) continue;
    const double kind = row[MIX_FX_KIND];
    if (kind == MIX_FX_DUCKER) {
      if (!limiters_only_ && ducker && !*ducker) *ducker = row;
      continue;
    }
    if (limiters_only_ && kind != MIX_FX_LIMITER) continue;
    long long code = -1;
    if (is_eq_kind(kind)) {
      code = kBiquad;
    } else if (kind == MIX_FX_COMPRESSOR) {
      code = kCompressor;
    } else if (kind == MIX_FX_GATE) {
      code = kGate;
    } else if (kind == MIX_FX_DEESSER) {
      code = kDeEsser;
    } else if (kind == MIX_FX_LIMITER) {
      // The look-ahead is structure: it sets the chain's latency.
      code = kLimiter + 8LL * Limiter::latency_for(row, sample_rate_);
    }
    if (code < 0) continue;
    if (stages >= MIX_BUS_MAX_STAGES) break;
    ++stages;
    if (!cs::try_push_back(*out, code)) return false;
  }
  return true;
}

bool BusChain::build(const double* rows, int count, double sample_rate, int channels, bool limiters_only,
                     const double** ducker) {
  sample_rate_ = sample_rate;
  channels_ = channels;
  limiters_only_ = limiters_only;
  order_.clear();
  biquads_.clear();
  compressors_.clear();
  gates_.clear();
  deessers_.clear();
  limiters_.clear();
  latency_ = 0;
  if (!signature(rows, count, &signature_, ducker)) return false;
  const size_t stages = signature_.size();
  if (!cs::try_reserve(order_, stages) || !cs::try_reserve(biquads_, stages) ||
      !cs::try_reserve(compressors_, stages) || !cs::try_reserve(gates_, stages) ||
      !cs::try_reserve(deessers_, stages) || !cs::try_reserve(limiters_, stages)) {
    return false;
  }
  for (int i = 0; i < count && order_.size() < stages; ++i) {
    const double* row = rows + static_cast<size_t>(i) * MIX_FX_STRIDE;
    if (row[MIX_FX_ENABLED] == 0.0) continue;
    const double kind = row[MIX_FX_KIND];
    if (limiters_only && kind != MIX_FX_LIMITER) continue;
    if (is_eq_kind(kind)) {
      biquads_.emplace_back();
      biquads_.back().design(row, sample_rate);
      order_.push_back({kBiquad, static_cast<int>(biquads_.size()) - 1});
    } else if (kind == MIX_FX_COMPRESSOR) {
      compressors_.emplace_back();
      compressors_.back().design(row, sample_rate);
      order_.push_back({kCompressor, static_cast<int>(compressors_.size()) - 1});
    } else if (kind == MIX_FX_GATE) {
      gates_.emplace_back();
      gates_.back().design(row, sample_rate);
      order_.push_back({kGate, static_cast<int>(gates_.size()) - 1});
    } else if (kind == MIX_FX_DEESSER) {
      deessers_.emplace_back();
      deessers_.back().design(row, sample_rate);
      order_.push_back({kDeEsser, static_cast<int>(deessers_.size()) - 1});
    } else if (kind == MIX_FX_LIMITER) {
      limiters_.emplace_back();
      if (!limiters_.back().design(row, sample_rate, channels)) {
        limiters_.pop_back();
        continue;
      }
      latency_ += limiters_.back().latency();
      order_.push_back({kLimiter, static_cast<int>(limiters_.size()) - 1});
    }
  }
  return true;
}

bool BusChain::matches(const double* rows, int count, const double** ducker) const {
  std::vector<long long> next;
  return signature(rows, count, &next, ducker) && next == signature_;
}

bool BusChain::retune(const double* rows, int count, const double** ducker) {
  if (!matches(rows, count, ducker)) return false;
  size_t stage = 0;
  for (int i = 0; i < count && stage < order_.size(); ++i) {
    const double* row = rows + static_cast<size_t>(i) * MIX_FX_STRIDE;
    if (row[MIX_FX_ENABLED] == 0.0) continue;
    const double kind = row[MIX_FX_KIND];
    if (kind == MIX_FX_DUCKER || (limiters_only_ && kind != MIX_FX_LIMITER)) continue;
    if (!is_eq_kind(kind) && kind != MIX_FX_COMPRESSOR && kind != MIX_FX_GATE && kind != MIX_FX_DEESSER &&
        kind != MIX_FX_LIMITER) {
      continue;
    }
    const Stage& s = order_[stage++];
    switch (s.kind) {
      case kBiquad:
        biquads_[s.index].design(row, sample_rate_, true);
        break;
      case kCompressor:
        compressors_[s.index].design(row, sample_rate_, true);
        break;
      case kGate:
        gates_[s.index].design(row, sample_rate_, true);
        break;
      case kDeEsser:
        deessers_[s.index].design(row, sample_rate_, true);
        break;
      case kLimiter:
        limiters_[s.index].retune(row, sample_rate_);
        break;
    }
  }
  return true;
}

void BusChain::reset() {
  for (Biquad& b : biquads_) b.reset();
  for (Compressor& c : compressors_) c.reset();
  for (Gate& g : gates_) g.reset();
  for (DeEsser& d : deessers_) d.reset();
  for (Limiter& l : limiters_) l.reset();
}

void BusChain::process(float* frame) {
  for (const Stage& s : order_) {
    switch (s.kind) {
      case kBiquad: {
        Biquad& b = biquads_[s.index];
        for (int c = 0; c < channels_; ++c) frame[c] = b.process(c, frame[c]);
        break;
      }
      case kCompressor: {
        const float g = compressors_[s.index].gain(frame_peak(frame, channels_));
        for (int c = 0; c < channels_; ++c) frame[c] *= g;
        break;
      }
      case kGate: {
        const float g = gates_[s.index].gain(frame_peak(frame, channels_));
        for (int c = 0; c < channels_; ++c) frame[c] *= g;
        break;
      }
      case kDeEsser:
        deessers_[s.index].process(frame, channels_);
        break;
      case kLimiter:
        limiters_[s.index].process(frame, frame);
        break;
    }
  }
}

double BusChain::reduction_db() const {
  double db = 0.0;
  for (const Stage& s : order_) {
    switch (s.kind) {
      case kBiquad:
        break;
      case kCompressor:
        db += compressors_[s.index].reduction_db();
        break;
      case kGate:
        db += gates_[s.index].reduction_db();
        break;
      case kDeEsser:
        db += deessers_[s.index].reduction_db();
        break;
      case kLimiter:
        db += gain_to_reduction_db(limiters_[s.index].last_gain());
        break;
    }
  }
  return db;
}

// ---------------------------------------------------------------------------
// BusGraph

bool BusGraph::valid_range(int first, int count, int effect_count) {
  return cs_span_ok(first, count, effect_count);
}

int BusGraph::validate(const BusLayout& l) const {
  if (l.effect_count < 0 || (l.effect_count > 0 && !l.effects)) return CS_EINVAL;
  if (l.bus_count < 0 || l.bus_count > MIX_BUS_MAX_LANES || (l.bus_count > 0 && !l.buses)) return CS_EINVAL;
  if (!std::isfinite(l.output_gain_db)) return CS_EINVAL;
  for (int b = 0; b < l.bus_count; ++b) {
    const int* bus = l.buses + b * MIX_BUS_STRIDE;
    if (!valid_range(bus[MIX_BUS_FX_FIRST], bus[MIX_BUS_FX_COUNT], l.effect_count)) return CS_ERANGE;
  }
  if (!valid_range(l.master_first, l.master_count, l.effect_count) ||
      !valid_range(l.final_first, l.final_count, l.effect_count)) {
    return CS_ERANGE;
  }
  return CS_OK;
}

int BusGraph::build(double sample_rate, int channels, const BusLayout& l, int flags) {
  if (!(sample_rate > 0) || !std::isfinite(sample_rate) || (channels != 1 && channels != 2)) return CS_EINVAL;
  sample_rate_ = sample_rate;
  channels_ = channels;
  const int rc = validate(l);
  if (rc != CS_OK) return rc;

  lanes_.clear();
  if (!cs::try_reserve(lanes_, static_cast<size_t>(l.bus_count) + 1)) return CS_ENOMEM;
  lanes_.resize(static_cast<size_t>(l.bus_count) + 1);
  lane_latency_ = 0;
  bool any = false;
  for (int b = 0; b < l.bus_count; ++b) {
    const int* bus = l.buses + b * MIX_BUS_STRIDE;
    Lane& lane = lanes_[b];
    const double* duck_row = nullptr;
    if (!lane.chain.build(l.effects + static_cast<size_t>(bus[MIX_BUS_FX_FIRST]) * MIX_FX_STRIDE,
                          bus[MIX_BUS_FX_COUNT], sample_rate, channels, false, &duck_row)) {
      return CS_ENOMEM;
    }
    if (duck_row) {
      // A key must already be processed this frame: packed before this lane.
      const double key = duck_row[MIX_FX_KEY];
      if (key >= 0.0 && key < static_cast<double>(b)) {
        lane.key = static_cast<int>(key);
        lane.has_duck = lane.duck.design(duck_row, sample_rate);
      }
    }
    any = any || !lane.chain.empty() || lane.has_duck;
    lane_latency_ = std::max(lane_latency_, lane.chain.latency());
  }
  for (Lane& lane : lanes_) {
    lane.pdc_frames = lane_latency_ - lane.chain.latency();
    const size_t pdc = static_cast<size_t>(lane.pdc_frames) * channels;
    if (!cs::try_reserve(lane.pdc, pdc)) return CS_ENOMEM;
    lane.pdc.assign(pdc, 0.f);
    lane.pdc_pos = 0;
  }
  if (!master_.build(l.effects + static_cast<size_t>(l.master_first) * MIX_FX_STRIDE, l.master_count, sample_rate,
                     channels, false, nullptr) ||
      !final_.build(l.effects + static_cast<size_t>(l.final_first) * MIX_FX_STRIDE, l.final_count, sample_rate,
                    channels, true, nullptr)) {
    return CS_ENOMEM;
  }
  const double gain_db = std::max(-60.0, std::min(60.0, l.output_gain_db));
  output_gain_ = gain_db == 0.0 ? 1.f : static_cast<float>(db_to_gain(gain_db));
  meter_on_ = (flags & MIX_BUS_FLAG_METER) != 0;
  if (meter_on_ && !meter_.init(sample_rate, channels)) return CS_EINVAL;
  if (!cs::try_reserve(lane_out_, lanes_.size() * channels)) return CS_ENOMEM;
  lane_out_.assign(lanes_.size() * channels, 0.f);
  latency_ = lane_latency_ + master_.latency() + final_.latency();
  active_ = any || !master_.empty() || !final_.empty() || output_gain_ != 1.f || meter_on_;
  processed_ = 0;
  master_gr_peak_ = 0.0;
  return CS_OK;
}

int BusGraph::retune(const BusLayout& l) {
  const int rc = validate(l);
  if (rc != CS_OK) return rc;
  if (l.bus_count != lane_count()) return CS_ESTATE;
  auto lane_rows = [&](int b) {
    const int* bus = l.buses + b * MIX_BUS_STRIDE;
    return l.effects + static_cast<size_t>(bus[MIX_BUS_FX_FIRST]) * MIX_FX_STRIDE;
  };
  auto lane_count_of = [&](int b) { return l.buses[b * MIX_BUS_STRIDE + MIX_BUS_FX_COUNT]; };
  const double* master_rows = l.effects + static_cast<size_t>(l.master_first) * MIX_FX_STRIDE;
  const double* final_rows = l.effects + static_cast<size_t>(l.final_first) * MIX_FX_STRIDE;

  // Check everything first, so a mismatch leaves the graph untouched.
  for (int b = 0; b < l.bus_count; ++b) {
    const Lane& lane = lanes_[b];
    const double* duck_row = nullptr;
    if (!lane.chain.matches(lane_rows(b), lane_count_of(b), &duck_row)) return CS_ESTATE;
    const bool duck = duck_row && duck_row[MIX_FX_KEY] >= 0.0 && duck_row[MIX_FX_KEY] < static_cast<double>(b);
    if (duck != lane.has_duck || (duck && static_cast<int>(duck_row[MIX_FX_KEY]) != lane.key)) return CS_ESTATE;
  }
  if (!master_.matches(master_rows, l.master_count, nullptr) || !final_.matches(final_rows, l.final_count, nullptr)) {
    return CS_ESTATE;
  }

  for (int b = 0; b < l.bus_count; ++b) {
    Lane& lane = lanes_[b];
    const double* duck_row = nullptr;
    lane.chain.retune(lane_rows(b), lane_count_of(b), &duck_row);
    if (lane.has_duck) lane.duck.design(duck_row, sample_rate_, true);
  }
  master_.retune(master_rows, l.master_count, nullptr);
  final_.retune(final_rows, l.final_count, nullptr);
  const double gain_db = std::max(-60.0, std::min(60.0, l.output_gain_db));
  output_gain_ = gain_db == 0.0 ? 1.f : static_cast<float>(db_to_gain(gain_db));
  return CS_OK;
}

void BusGraph::process(const float* lanes, float* out, int frames) {
  const int ch = channels_;
  const size_t block = static_cast<size_t>(frames) * ch;
  const int lane_total = static_cast<int>(lanes_.size());
  for (int f = 0; f < frames; ++f) {
    float sum[2] = {0.f, 0.f};
    for (int l = 0; l < lane_total; ++l) {
      Lane& lane = lanes_[l];
      const float* in = lanes + l * block + static_cast<size_t>(f) * ch;
      float x[2] = {in[0], ch > 1 ? in[1] : 0.f};
      if (!lane.chain.empty()) lane.chain.process(x);
      if (lane.pdc_frames > 0) {
        float* slot = lane.pdc.data() + static_cast<size_t>(lane.pdc_pos) * ch;
        for (int c = 0; c < ch; ++c) std::swap(slot[c], x[c]);
        if (++lane.pdc_pos == lane.pdc_frames) lane.pdc_pos = 0;
      }
      if (lane.has_duck) {
        const float g = lane.duck.gain(frame_peak(lane_out_.data() + static_cast<size_t>(lane.key) * ch, ch));
        if (g != 1.f) {
          for (int c = 0; c < ch; ++c) x[c] *= g;
        }
      }
      if (meter_on_) {
        double gr = lane.chain.empty() ? 0.0 : lane.chain.reduction_db();
        if (lane.has_duck) gr += lane.duck.reduction_db();
        lane.gr_peak = std::max(lane.gr_peak, gr);
      }
      float* keep = lane_out_.data() + static_cast<size_t>(l) * ch;
      for (int c = 0; c < ch; ++c) {
        keep[c] = x[c];
        sum[c] += x[c];
      }
    }
    if (!master_.empty()) master_.process(sum);
    if (output_gain_ != 1.f) {
      for (int c = 0; c < ch; ++c) sum[c] *= output_gain_;
    }
    if (!final_.empty()) final_.process(sum);
    if (meter_on_) {
      master_gr_peak_ = std::max(master_gr_peak_, master_.reduction_db() + final_.reduction_db());
      // The first `latency` frames are look-ahead priming, not programme.
      if (processed_ >= latency_) meter_.push(sum);
    }
    ++processed_;
    float* o = out + static_cast<size_t>(f) * ch;
    for (int c = 0; c < ch; ++c) o[c] = sum[c];
  }
}

int BusGraph::meters(double* out, int capacity) {
  if (!meter_on_ || !out || capacity <= 0) return 0;
  const int lanes = lane_count();
  const int total = MIX_METER_LANE_GR + lanes;
  const int n = std::min(capacity, total);
  for (int i = 0; i < n; ++i) {
    double v = 0.0;
    switch (i) {
      case MIX_METER_MOMENTARY:
        v = meter_.momentary();
        break;
      case MIX_METER_SHORT_TERM:
        v = meter_.short_term();
        break;
      case MIX_METER_INTEGRATED:
        v = meter_.integrated();
        break;
      case MIX_METER_RANGE:
        v = meter_.range();
        break;
      case MIX_METER_TRUE_PEAK:
        v = meter_.true_peak_db();
        break;
      case MIX_METER_SAMPLE_PEAK:
        v = meter_.sample_peak_db();
        break;
      case MIX_METER_MASTER_GR:
        v = master_gr_peak_;
        break;
      default:
        v = lanes_[i - MIX_METER_LANE_GR].gr_peak;
        break;
    }
    out[i] = v;
  }
  master_gr_peak_ = 0.0;
  for (Lane& lane : lanes_) lane.gr_peak = 0.0;
  return n;
}

void BusGraph::reset_meter() {
  if (meter_on_) meter_.reset();
  master_gr_peak_ = 0.0;
  for (Lane& lane : lanes_) lane.gr_peak = 0.0;
}

void BusGraph::reset() {
  for (Lane& lane : lanes_) {
    lane.chain.reset();
    std::fill(lane.pdc.begin(), lane.pdc.end(), 0.f);
    lane.pdc_pos = 0;
    lane.duck.reset();
  }
  std::fill(lane_out_.begin(), lane_out_.end(), 0.f);
  master_.reset();
  final_.reset();
  // The meter keeps measuring across a seek (EBU Mode: only an explicit
  // reset restarts it); it skips the graph's priming frames again.
  processed_ = 0;
}

}  // namespace media_engine

// ---------------------------------------------------------------------------
// C API

struct BusGraphHandle {
  media_engine::BusGraph graph;
};

struct LoudnessMeterHandle {
  media_engine::LoudnessMeter meter;
};

namespace {

media_engine::BusLayout make_layout(const double* effects, int effect_count, const int* buses, int bus_count,
                                    int master_first, int master_count, double output_gain_db, int final_first,
                                    int final_count) {
  media_engine::BusLayout l;
  l.effects = effects;
  l.effect_count = effect_count;
  l.buses = buses;
  l.bus_count = bus_count;
  l.master_first = master_first;
  l.master_count = master_count;
  l.output_gain_db = output_gain_db;
  l.final_first = final_first;
  l.final_count = final_count;
  return l;
}

}  // namespace

BusGraphHandle* bus_graph_create(int sample_rate, int channels, const double* effects, int effect_count,
                                 const int* buses, int bus_count, int master_first, int master_count,
                                 double output_gain_db, int final_first, int final_count, int flags) {
  BusGraphHandle* handle = new (std::nothrow) BusGraphHandle();
  if (!handle) return nullptr;
  const media_engine::BusLayout layout = make_layout(effects, effect_count, buses, bus_count, master_first,
                                                     master_count, output_gain_db, final_first, final_count);
  if (handle->graph.build(static_cast<double>(sample_rate), channels, layout, flags) != CS_OK) {
    delete handle;
    return nullptr;
  }
  return handle;
}

int bus_graph_update(BusGraphHandle* graph, const double* effects, int effect_count, const int* buses, int bus_count,
                     int master_first, int master_count, double output_gain_db, int final_first, int final_count) {
  if (!graph) return CS_EINVAL;
  return graph->graph.retune(make_layout(effects, effect_count, buses, bus_count, master_first, master_count,
                                         output_gain_db, final_first, final_count));
}

int bus_graph_latency(const BusGraphHandle* graph) { return graph ? graph->graph.latency() : 0; }

int bus_graph_process(BusGraphHandle* graph, const float* lanes, float* out, int frames) {
  if (!graph || !lanes || !out || frames < 0) return CS_EINVAL;
  graph->graph.process(lanes, out, frames);
  return CS_OK;
}

int bus_graph_meters(BusGraphHandle* graph, double* out, int capacity) {
  if (!graph) return CS_EINVAL;
  return graph->graph.meters(out, capacity);
}

void bus_graph_reset_meter(BusGraphHandle* graph) {
  if (graph) graph->graph.reset_meter();
}

void bus_graph_reset(BusGraphHandle* graph) {
  if (graph) graph->graph.reset();
}

void bus_graph_destroy(BusGraphHandle* graph) { delete graph; }

LoudnessMeterHandle* loudness_meter_create(int sample_rate, int channels) {
  LoudnessMeterHandle* handle = new (std::nothrow) LoudnessMeterHandle();
  if (!handle) return nullptr;
  if (!handle->meter.init(static_cast<double>(sample_rate), channels)) {
    delete handle;
    return nullptr;
  }
  return handle;
}

int loudness_meter_process(LoudnessMeterHandle* meter, const float* interleaved, int frames) {
  if (!meter || frames < 0 || (frames > 0 && !interleaved)) return CS_EINVAL;
  bool ok = true;
  const int ch = meter->meter.channels();
  for (int f = 0; f < frames; ++f) ok = meter->meter.push(interleaved + static_cast<size_t>(f) * ch) && ok;
  return ok ? CS_OK : CS_ENOMEM;
}

int loudness_meter_read(const LoudnessMeterHandle* meter, double* out, int capacity) {
  if (!meter || !out || capacity < 0) return CS_EINVAL;
  const media_engine::LoudnessMeter& m = meter->meter;
  const double values[] = {m.momentary(), m.short_term(), m.integrated(), m.range(), m.true_peak_db(),
                           m.sample_peak_db()};
  const int n = std::min(capacity, static_cast<int>(sizeof(values) / sizeof(values[0])));
  for (int i = 0; i < n; ++i) out[i] = values[i];
  return n;
}

void loudness_meter_destroy(LoudnessMeterHandle* meter) { delete meter; }
