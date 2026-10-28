// Host tests for the audio-analysis module (kissfft band energy + onsets).
// Same sources as public/wasm/audio_analysis.wasm, built natively under ASan +
// UBSan by scripts/test-native.sh.

#include "audio_analysis.h"
#include "host_test.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace {

constexpr int kRate = 44100;
constexpr int kFft = 2048;
constexpr double kPi = 3.14159265358979323846;

struct Frame {
  float bands[AUDIO_ANALYSIS_BAND_COUNT];
  float beat;
};

/** Run `signal` through the analyzer hop by hop. */
std::vector<Frame> analyze(void* a, const std::vector<float>& signal) {
  const int hop = getHopSize(a);
  std::vector<Frame> frames;
  std::vector<float> window(kFft, 0.f);
  for (size_t start = 0; start + kFft <= signal.size(); start += static_cast<size_t>(hop)) {
    std::copy(signal.begin() + static_cast<long>(start),
              signal.begin() + static_cast<long>(start) + kFft, window.begin());
    Frame f{};
    analyzeFrame(a, window.data(), kFft, f.bands, &f.beat);
    frames.push_back(f);
  }
  return frames;
}

std::vector<float> sine(double hz, int samples, float amp = 0.5f) {
  std::vector<float> out(static_cast<size_t>(samples));
  for (int i = 0; i < samples; ++i) {
    out[static_cast<size_t>(i)] = amp * static_cast<float>(std::sin(2.0 * kPi * hz * i / kRate));
  }
  return out;
}

/** Same log-spaced edges as initBands(): band b covers [f(b), f(b+1)). */
double bandCentreHz(int b) {
  const double fMin = 20.0;
  const double fMax = kRate * 0.5;
  return fMin * std::pow(fMax / fMin, (b + 0.5) / AUDIO_ANALYSIS_BAND_COUNT);
}

}  // namespace

TEST_CASE(create_rejects_bad_sample_rate) {
  CHECK(createAnalyzer(100, kFft) == nullptr);
  CHECK(createAnalyzer(400000, kFft) == nullptr);
}

TEST_CASE(hop_is_half_the_fft_size) {
  for (int fft : {256, 1024, 2048, 8192}) {
    void* a = createAnalyzer(kRate, fft);
    CHECK(a != nullptr);
    CHECK(getHopSize(a) == fft / 2);
    destroyAnalyzer(a);
  }
  // Non-power-of-two rounds up; out-of-range clamps.
  void* a = createAnalyzer(kRate, 1500);
  CHECK(getHopSize(a) == 1024);
  destroyAnalyzer(a);
  a = createAnalyzer(kRate, 1 << 16);
  CHECK(getHopSize(a) == 4096);
  destroyAnalyzer(a);
  CHECK(getHopSize(nullptr) == 0);
}

TEST_CASE(silence_has_no_energy_and_no_beat) {
  void* a = createAnalyzer(kRate, kFft);
  const std::vector<Frame> frames = analyze(a, std::vector<float>(kRate * 2, 0.f));
  CHECK(frames.size() > 50);
  for (const Frame& f : frames) {
    for (float b : f.bands) CHECK(b == 0.f);
    CHECK(f.beat == 0.f);
  }
  destroyAnalyzer(a);
}

TEST_CASE(sine_lights_only_its_band) {
  // Bands 2..6: wide enough at 2048 points that the Hann main lobe stays inside.
  // Band energy is a mean over the band's bins, so wide bands read lower in
  // absolute terms; the check is that the target dominates.
  for (int target = 2; target <= 6; ++target) {
    void* a = createAnalyzer(kRate, kFft);
    const std::vector<Frame> frames = analyze(a, sine(bandCentreHz(target), kRate));
    const Frame& f = frames.back();
    float others = 0.f;
    for (int b = 0; b < AUDIO_ANALYSIS_BAND_COUNT; ++b) {
      if (b != target) others = std::max(others, f.bands[b]);
    }
    CHECK_GE(f.bands[target], 0.1f);
    CHECK_LE(others, f.bands[target] * 0.1f);
    destroyAnalyzer(a);
  }
}

TEST_CASE(click_after_silence_is_an_onset) {
  void* a = createAnalyzer(kRate, kFft);
  std::vector<float> signal(kRate * 2, 0.f);
  const size_t click = kRate;  // 1 s in
  for (size_t i = 0; i < 64; ++i) signal[click + i] = (i % 2 == 0) ? 0.9f : -0.9f;
  const std::vector<Frame> frames = analyze(a, signal);
  const int hop = getHopSize(a);

  int firstBeat = -1;
  for (size_t i = 0; i < frames.size(); ++i) {
    if (frames[i].beat == 1.f) {
      firstBeat = static_cast<int>(i);
      break;
    }
  }
  CHECK(firstBeat >= 0);
  // The first window that contains the click is the one that fires.
  const int expected = static_cast<int>((click + 64 - kFft) / static_cast<size_t>(hop)) + 1;
  CHECK_LE(std::abs(firstBeat - expected), 1);
  // Envelope decays after the impulse rather than sticking at 1.
  if (firstBeat >= 0 && static_cast<size_t>(firstBeat) + 1 < frames.size()) {
    CHECK(frames[static_cast<size_t>(firstBeat) + 1].beat < 1.f);
  }

  // reset clears the onset state: silence afterwards stays at zero beat.
  resetAnalyzer(a);
  for (const Frame& f : analyze(a, std::vector<float>(kFft * 4, 0.f))) CHECK(f.beat == 0.f);
  destroyAnalyzer(a);
}

TEST_CASE(null_handle_is_ignored) {
  float bands[AUDIO_ANALYSIS_BAND_COUNT] = {};
  float beat = 0.f;
  float pcm[4] = {};
  analyzeFrame(nullptr, pcm, 4, bands, &beat);
  resetAnalyzer(nullptr);
  destroyAnalyzer(nullptr);
  CHECK(beat == 0.f);
}
