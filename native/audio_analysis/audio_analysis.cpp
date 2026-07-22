#include "audio_analysis.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

#include "third_party/kissfft/kiss_fft.h"

namespace {

constexpr int kMinFft = 256;
constexpr int kMaxFft = 8192;
constexpr int kFluxHistory = 43; // ~0.5 s at hop≈512 @ 44.1 kHz
constexpr float kMinBeatIntervalSec = 0.28f; // ~214 BPM ceiling
constexpr float kBeatDecay = 0.88f;

bool isPowerOfTwo(int n) {
  return n > 0 && (n & (n - 1)) == 0;
}

int clampFftSize(int fftSize) {
  if (!isPowerOfTwo(fftSize)) {
    // Round up to next power of two.
    int v = std::max(kMinFft, fftSize);
    v--;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v |= v >> 16;
    v++;
    fftSize = v;
  }
  return std::clamp(fftSize, kMinFft, kMaxFft);
}

float hannWindow(int i, int n) {
  if (n <= 1) return 1.f;
  return 0.5f * (1.f - std::cos(2.f * static_cast<float>(M_PI) * static_cast<float>(i) /
                                 static_cast<float>(n - 1)));
}

struct Analyzer {
  int sampleRate = 44100;
  int fftSize = 2048;
  int hopSize = 1024;
  int bins = 0;

  kiss_fft_cfg cfg = nullptr;
  std::vector<kiss_fft_cpx> timeBuf;
  std::vector<kiss_fft_cpx> freqBuf;
  std::vector<float> window;
  std::vector<float> magnitude;
  std::vector<float> prevMagnitude;
  std::vector<float> fluxHistory;
  int fluxWrite = 0;
  int fluxCount = 0;

  float beatEnvelope = 0.f;
  double samplesProcessed = 0.0;
  double lastBeatSample = -1.0e9;

  // Band bin ranges [start, end)
  int bandStart[AUDIO_ANALYSIS_BAND_COUNT]{};
  int bandEnd[AUDIO_ANALYSIS_BAND_COUNT]{};
};

void initBands(Analyzer* a) {
  const float nyquist = static_cast<float>(a->sampleRate) * 0.5f;
  // Log-spaced edges from ~20 Hz to nyquist.
  const float fMin = 20.f;
  const float fMax = std::max(fMin * 2.f, nyquist);
  const int usefulBins = a->bins; // excludes DC? we include from bin 1

  for (int b = 0; b < AUDIO_ANALYSIS_BAND_COUNT; ++b) {
    const float t0 = static_cast<float>(b) / AUDIO_ANALYSIS_BAND_COUNT;
    const float t1 = static_cast<float>(b + 1) / AUDIO_ANALYSIS_BAND_COUNT;
    const float freq0 = fMin * std::pow(fMax / fMin, t0);
    const float freq1 = fMin * std::pow(fMax / fMin, t1);
    int s = static_cast<int>(freq0 * a->fftSize / static_cast<float>(a->sampleRate));
    int e = static_cast<int>(freq1 * a->fftSize / static_cast<float>(a->sampleRate));
    s = std::clamp(s, 1, usefulBins - 1);
    e = std::clamp(e, s + 1, usefulBins);
    a->bandStart[b] = s;
    a->bandEnd[b] = e;
  }
}

float medianOfHistory(const Analyzer* a) {
  if (a->fluxCount <= 0) return 0.f;
  std::vector<float> tmp(a->fluxHistory.begin(),
                         a->fluxHistory.begin() + a->fluxCount);
  const int mid = static_cast<int>(tmp.size()) / 2;
  std::nth_element(tmp.begin(), tmp.begin() + mid, tmp.end());
  return tmp[mid];
}

} // namespace

extern "C" {

void* createAnalyzer(int sampleRate, int fftSize) {
  if (sampleRate < 8000 || sampleRate > 192000) return nullptr;
  fftSize = clampFftSize(fftSize);

  auto* a = new (std::nothrow) Analyzer();
  if (!a) return nullptr;

  a->sampleRate = sampleRate;
  a->fftSize = fftSize;
  a->hopSize = fftSize / 2;
  a->bins = fftSize / 2;
  a->cfg = kiss_fft_alloc(fftSize, /*inverse=*/0, nullptr, nullptr);
  if (!a->cfg) {
    delete a;
    return nullptr;
  }

  a->timeBuf.resize(static_cast<size_t>(fftSize));
  a->freqBuf.resize(static_cast<size_t>(fftSize));
  a->window.resize(static_cast<size_t>(fftSize));
  a->magnitude.assign(static_cast<size_t>(a->bins), 0.f);
  a->prevMagnitude.assign(static_cast<size_t>(a->bins), 0.f);
  a->fluxHistory.assign(kFluxHistory, 0.f);

  for (int i = 0; i < fftSize; ++i) {
    a->window[static_cast<size_t>(i)] = hannWindow(i, fftSize);
  }

  initBands(a);
  return a;
}

void resetAnalyzer(void* handle) {
  auto* a = static_cast<Analyzer*>(handle);
  if (!a) return;
  std::fill(a->prevMagnitude.begin(), a->prevMagnitude.end(), 0.f);
  std::fill(a->fluxHistory.begin(), a->fluxHistory.end(), 0.f);
  a->fluxWrite = 0;
  a->fluxCount = 0;
  a->beatEnvelope = 0.f;
  a->samplesProcessed = 0.0;
  a->lastBeatSample = -1.0e9;
}

void destroyAnalyzer(void* handle) {
  auto* a = static_cast<Analyzer*>(handle);
  if (!a) return;
  if (a->cfg) {
    kiss_fft_free(a->cfg);
    a->cfg = nullptr;
  }
  delete a;
}

int getHopSize(void* handle) {
  auto* a = static_cast<Analyzer*>(handle);
  if (!a) return 0;
  return a->hopSize;
}

void analyzeFrame(void* handle, const float* pcm, int numSamples,
                  float* outBands, float* outBeat) {
  auto* a = static_cast<Analyzer*>(handle);
  if (!a || !pcm || !outBands || !outBeat) return;

  const int n = a->fftSize;
  // Copy + window + window-pad
  for (int i = 0; i < n; ++i) {
    const float s = (i < numSamples) ? pcm[i] : 0.f;
    a->timeBuf[static_cast<size_t>(i)].r = s * a->window[static_cast<size_t>(i)];
    a->timeBuf[static_cast<size_t>(i)].i = 0.f;
  }

  kiss_fft(a->cfg, a->timeBuf.data(), a->freqBuf.data());

  // Magnitude spectrum (first half)
  float flux = 0.f;
  for (int i = 0; i < a->bins; ++i) {
    const auto& c = a->freqBuf[static_cast<size_t>(i)];
    const float mag = std::sqrt(c.r * c.r + c.i * c.i);
    const float prev = a->prevMagnitude[static_cast<size_t>(i)];
    const float diff = mag - prev;
    if (diff > 0.f) flux += diff;
    a->magnitude[static_cast<size_t>(i)] = mag;
    a->prevMagnitude[static_cast<size_t>(i)] = mag;
  }

  // Normalize flux roughly by bin count
  flux /= static_cast<float>(std::max(1, a->bins));

  a->fluxHistory[static_cast<size_t>(a->fluxWrite)] = flux;
  a->fluxWrite = (a->fluxWrite + 1) % kFluxHistory;
  if (a->fluxCount < kFluxHistory) a->fluxCount++;

  const float med = medianOfHistory(a);
  const float threshold = med * 1.5f + 1e-4f;
  const double nowSample = a->samplesProcessed;
  const double minInterval = static_cast<double>(kMinBeatIntervalSec) *
                             static_cast<double>(a->sampleRate);

  bool isBeat = false;
  if (flux > threshold && (nowSample - a->lastBeatSample) >= minInterval) {
    // Require local peak vs previous history slot
    const int prevIdx = (a->fluxWrite + kFluxHistory - 2) % kFluxHistory;
    const float prevFlux =
        a->fluxCount > 1 ? a->fluxHistory[static_cast<size_t>(prevIdx)] : 0.f;
    if (flux >= prevFlux) {
      isBeat = true;
      a->lastBeatSample = nowSample;
      a->beatEnvelope = 1.f;
    }
  }

  if (!isBeat) {
    a->beatEnvelope *= kBeatDecay;
    if (a->beatEnvelope < 0.01f) a->beatEnvelope = 0.f;
  }

  // Band energies (RMS-ish mean of magnitudes, compressed to 0..1)
  for (int b = 0; b < AUDIO_ANALYSIS_BAND_COUNT; ++b) {
    float sum = 0.f;
    const int s = a->bandStart[b];
    const int e = a->bandEnd[b];
    const int count = std::max(1, e - s);
    for (int i = s; i < e; ++i) {
      sum += a->magnitude[static_cast<size_t>(i)];
    }
    const float mean = sum / static_cast<float>(count);
    // Soft compress: 1 - exp(-k * mean)
    outBands[b] = 1.f - std::exp(-0.08f * mean);
  }

  *outBeat = a->beatEnvelope;
  a->samplesProcessed += static_cast<double>(
      numSamples > 0 ? std::min(numSamples, a->hopSize) : a->hopSize);
}

} // extern "C"
