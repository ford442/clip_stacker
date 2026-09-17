// Thin C wrapper around whisper.cpp exposing per-segment timings to JS.
//
// whisper.cpp's own `whisper.wasm` example only prints text to stdout, which
// is useless for captions — a cue needs a start and an end. This wrapper keeps
// the context alive between calls, runs one transcription at a time, and lets
// JS read back `[startMs, endMs, text]` per segment.
//
// Progress and cancellation cross into JS through `Module.onWhisperProgress`:
// the WASM call blocks its worker for the whole run, so the only place the UI's
// cancel flag can be read is from inside whisper's progress callback. A
// non-zero return aborts the run.

#include <emscripten.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "whisper.h"

namespace {

struct Segment {
  int start_ms;
  int end_ms;
  std::string text;
};

struct Session {
  whisper_context* ctx = nullptr;
  std::vector<Segment> segments;
  bool aborted = false;
};

// One session at a time is all the UI can start; handle 1 is that session.
Session g_session;

}  // namespace

EM_JS(int, whisper_js_progress, (float progress), {
  if (typeof Module !== 'undefined' &&
      typeof Module.onWhisperProgress === 'function') {
    return Module.onWhisperProgress(progress) | 0;
  }
  return 0;
});

extern "C" {

EMSCRIPTEN_KEEPALIVE
int whisperInit(const uint8_t* model, int model_bytes) {
  if (!model || model_bytes <= 0) return 0;
  if (g_session.ctx) {
    whisper_free(g_session.ctx);
    g_session.ctx = nullptr;
  }
  whisper_context_params cparams = whisper_context_default_params();
  g_session.ctx = whisper_init_from_buffer_with_params(
      const_cast<uint8_t*>(model), static_cast<size_t>(model_bytes), cparams);
  return g_session.ctx ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void whisperFree(int handle) {
  (void)handle;
  if (g_session.ctx) {
    whisper_free(g_session.ctx);
    g_session.ctx = nullptr;
  }
  g_session.segments.clear();
}

EMSCRIPTEN_KEEPALIVE
int whisperTranscribe(int handle, const float* pcm, int samples,
                      const char* language, int threads) {
  (void)handle;
  if (!g_session.ctx || !pcm || samples <= 0) return -1;

  g_session.segments.clear();
  g_session.aborted = false;

  whisper_full_params params =
      whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.print_progress = false;
  params.print_realtime = false;
  params.print_timestamps = false;
  params.translate = false;
  params.n_threads = threads > 0 ? threads : 1;
  params.language = (language && std::strcmp(language, "auto") != 0) ? language : nullptr;
  // Language stays null for "auto" so whisper detects it.

  params.progress_callback = [](struct whisper_context*, struct whisper_state*,
                                int progress, void*) {
    if (whisper_js_progress(static_cast<float>(progress) / 100.0f) != 0) {
      g_session.aborted = true;
    }
  };
  params.abort_callback = [](void*) -> bool { return g_session.aborted; };

  const int status = whisper_full(g_session.ctx, params, pcm, samples);
  if (g_session.aborted) return -2;
  if (status != 0) return -3;

  const int count = whisper_full_n_segments(g_session.ctx);
  g_session.segments.reserve(static_cast<size_t>(count));
  for (int i = 0; i < count; ++i) {
    // whisper reports centiseconds; the JS side speaks milliseconds.
    g_session.segments.push_back(Segment{
        static_cast<int>(whisper_full_get_segment_t0(g_session.ctx, i) * 10),
        static_cast<int>(whisper_full_get_segment_t1(g_session.ctx, i) * 10),
        std::string(whisper_full_get_segment_text(g_session.ctx, i)),
    });
  }
  return count;
}

EMSCRIPTEN_KEEPALIVE
int whisperSegmentStartMs(int handle, int index) {
  (void)handle;
  if (index < 0 || index >= static_cast<int>(g_session.segments.size())) return 0;
  return g_session.segments[static_cast<size_t>(index)].start_ms;
}

EMSCRIPTEN_KEEPALIVE
int whisperSegmentEndMs(int handle, int index) {
  (void)handle;
  if (index < 0 || index >= static_cast<int>(g_session.segments.size())) return 0;
  return g_session.segments[static_cast<size_t>(index)].end_ms;
}

EMSCRIPTEN_KEEPALIVE
const char* whisperSegmentText(int handle, int index) {
  (void)handle;
  if (index < 0 || index >= static_cast<int>(g_session.segments.size())) return "";
  return g_session.segments[static_cast<size_t>(index)].text.c_str();
}

}  // extern "C"
