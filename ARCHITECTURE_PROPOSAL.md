# clip_stacker: C++ WASM + WebGPU Architecture Proposal

**Author:** Senior Systems / Browser Media Engineer  
**Date:** 2026-06-03  
**Status:** Investigation & Design — Ready for Review  

---

## Table of Contents

1. [Current Architecture (Deep Analysis)](#1-current-architecture-deep-analysis)
2. [Proposed New Architecture](#2-proposed-new-architecture)
3. [C++ Media Engine Design](#3-c-media-engine-design)
4. [WebGPU Acceleration Opportunities](#4-webgpu-acceleration-opportunities)
5. [Implementation Roadmap](#5-implementation-roadmap)
6. [Code Sketches & Interfaces](#6-code-sketches--interfaces)
7. [Risks, Compatibility & Debugging](#7-risks-compatibility--debugging)
8. [Quick Wins (< 1 Day)](#8-quick-wins--1-day)

---

## 1. Current Architecture (Deep Analysis)

### 1.1 Component Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                App.tsx                                       │
│  State: clips[], clipGroups[], transitions[], textOverlays[],                │
│         exportSettings, forceFFmpeg, useCanvasRenderer, audioReactive,       │
│         forceReencode, renderPlan                                            │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
         ┌───────────────┐      ┌─────────────────┐
         │  hybrid-encoder.ts    │      │  calculateRenderPlan()  │
         │  (encoder routing)    │      └─────────────────┘
         └───────┬───────┘
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌────────┐ ┌──────────┐ ┌─────────────┐
│ Canvas │ │ WebCodecs│ │ FFmpeg.wasm │
│ Path   │ │ GPU Path │ │ CPU Path    │
└───┬────┘ └────┬─────┘ └──────┬──────┘
    │           │              │
    ▼           ▼              ▼
┌────────┐ ┌──────────┐ ┌─────────────────────────────────────────┐
│Canvas  │ │VideoEnc  │ │ Singleton FFmpeg Service                │
│Renderer│ │AudioEnc  │ │ • ensureFfmpeg() with retry + CDN fallb.│
│(2D+rAF)│ │mp4-muxer │ │ • Log ring buffer (300 lines)           │
│Media   │ │          │ │ • Aggressive VFS cleanup                │
│Recorder│ │          │ │ • Generation-counter load racing        │
│  +     │ │          │ │ • safeExec / safeWrite / safeRead       │
│FFmpeg  │ │          │ │ • muxVideoWithAudio()                   │
│audio   │ │          │ │                                         │
│mux     │ │          │ │ Render paths:                           │
│        │ │          │ │ 1. lossless concat (-c copy)            │
│        │ │          │ │ 2. two-pass re-encode (per-clip filters)│
│        │ │          │ │ 3. transitions (xfade/acrossfade)       │
│        │ │          │ │ 4. PiP compositing (overlay chain)      │
│        │ │          │ │ 5. text overlays (drawtext post-pass)   │
└────────┘ └──────────┘ └─────────────────────────────────────────┘
```

### 1.2 Data Flow by Path

#### A. Simple Lossless Concat
```
clips[] ──► write to FFmpeg VFS ──► concat demuxer (-f concat -c copy)
                                    ──► stacked.mp4
```
**Trigger:** Single clean video clip, no effects, no transitions, no overlays, no PiP.
**Performance:** Fastest. Stream copy. No quality loss.
**Limitation:** Disabled when `forceReencode` is true or when multiple clips need resolution normalization.

#### B. Two-Pass Re-encode (Effects)
```
clips[] ──► VFS ──► Pass 1: per-clip filter_complex
                    (trim → scale 1280x720 → pad → fade → libx264 CRF)
                    ──► intermediate-0.mp4, intermediate-1.mp4, ...
                    
                    Pass 2: concat demuxer (-c copy)
                    ──► stacked.mp4
                    
textOverlays[] ──► drawtext post-pass ──► stacked_final.mp4
```
**Trigger:** Any clip has fades, is audio-only, is RIFE-processed, or multiple clips need normalization.
**Performance:** Slow. Each clip is fully re-encoded through FFmpeg's software filter graph.
**Memory:** Source files + intermediates + output all in WASM VFS (~2-3× source size).

#### C. Transitions Path
```
clips[] ──► VFS ──► single filter_complex:
                    [per-clip trim/scale/fade] → [xfade chain] + [acrossfade chain]
                    ──► stacked.mp4
```
**Trigger:** Active transitions (`type !== 'none'`).
**Performance:** Single-pass but filter_complex is O(n²) memory hungry for long clips because xfade keeps both inputs alive.
**Bottleneck:** FFmpeg's `xfade` transition requires both video streams buffered in memory simultaneously.

#### D. PiP / Compositing Path
```
clips[] ──► VFS ──► single filter_complex:
                    base layer: concat
                    overlays: scale → opacity → overlay chain
                    audio: amix
                    ──► stacked.mp4
```
**Trigger:** Any clip has `layerIndex > 0`.
**Performance:** Heaviest filter graph. Multiple concurrent decoded streams.

#### E. Canvas Path (Hybrid)
```
clips[] ──► CanvasRenderer ──► hidden <video> + rAF + 2D canvas
            (real-time playback, audio-reactive glow, fade overlay)
            ──► MediaRecorder.captureStream() ──► video-only blob
            ──► FFmpeg muxVideoWithAudio()
                (audio: trim → fade → concat → AAC)
                ──► final MP4
```
**Trigger:** `useCanvasRenderer === true` and `MediaRecorder` available.
**Performance:** Real-time (1× speed). Cannot go faster than playback duration.
**Value:** Audio-reactive effects, live compositing preview.
**Limitation:** No transitions, no PiP, no text overlays. Canvas is 2D only.

#### F. WebCodecs GPU Path
```
clips[] ──► HTMLVideoElement ──► requestVideoFrameCallback
            ──► Canvas2D (letterbox + fade overlay)
            ──► VideoFrame ──► VideoEncoder (hardware H.264)
            
            audio: fetch → OfflineAudioContext (trim + fade + resample)
            ──► AudioData ──► AudioEncoder (AAC)
            
            ──► mp4-muxer ──► Blob
```
**Trigger:** `!forceFFmpeg && !useCanvasRenderer && isWebCodecsAvailable()` and no transitions/PiP/text/RIFE.
**Performance:** Fastest GPU path. ~3× playback speed (via `playbackRate = 3`).
**Limitation:** No transitions, PiP, text overlays, or RIFE clips. Canvas2D per-frame copy is CPU-bound.

### 1.3 Identified Bottlenecks

| Bottleneck | Severity | Root Cause |
|------------|----------|------------|
| **FFmpeg filter_complex memory pressure** | 🔴 Critical | All intermediate frames decoded into WASM linear memory; xfade/PiP hold multiple streams |
| **No live effects preview** | 🔴 Critical | Preview.tsx shows raw `<video>` only; users render blind |
| **Canvas path is 1× real-time** | 🟡 High | MediaRecorder capture forces playback-speed rendering |
| **WebCodecs canvas2D copy** | 🟡 High | `drawImage(video → canvas)` + `new VideoFrame(canvas)` per frame is CPU-bound |
| **Single-threaded FFmpeg** | 🟡 High | No pthreads configured; all encode/decode/filter on one thread |
| **Aggressive VFS cleanup is reactive** | 🟡 Medium | Only cleans after render; no streaming/chunked processing |
| **Thumbnail extraction is slow** | 🟢 Low | Sequential video seeks with 1.5s timeout per frame |
| **Audio resampling in FFmpeg** | 🟢 Low | `aresample=44100` in filter graph; could be native Web Audio |

---

## 2. Proposed New Architecture

### 2.1 Design Principles

1. **Preserve what works:** The FFmpeg singleton service, render plan logic, VFS cleanup discipline, and diagnostic log capture are excellent. Do not refactor them away.
2. **Layered backends:** `calculateRenderPlan` becomes `selectRenderBackend` — a capability-aware router, not just a description generator.
3. **WebGPU first for pixels:** GPU compute/graphics should own the pixel pipeline. C++ WASM should own audio DSP and frame buffer orchestration.
4. **Zero-copy where possible:** SharedArrayBuffer + `VideoFrame` import/export between WebGPU, WebCodecs, and C++.
5. **Progressive enhancement:** Every new path must have a clean fallback to the existing FFmpeg path.

### 2.2 Target Architecture (12-Month Vision)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              App.tsx                                         │
│  State + UI (unchanged surface)                                              │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │  Render Backend Router│
                    │  (evolved from        │
                    │   calculateRenderPlan)│
                    └──────────┬───────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
   ┌──────────┐        ┌──────────────┐       ┌──────────────┐
   │ WebGPU   │        │ C++ Media    │       │ FFmpeg.wasm  │
   │ Composer │◄──────►│ Engine (WASM)│       │ (Fallback)   │
   │ (Pixel)  │        │ (Audio/Buf)  │       │ (Full encode)│
   └────┬─────┘        └──────┬───────┘       └──────┬───────┘
        │                     │                      │
        ▼                     ▼                      ▼
   ┌──────────┐        ┌──────────────┐       ┌──────────────┐
   │WebCodecs │        │ Web Audio    │       │ VFS + libx264│
   │VideoEnc  │        │ (Analyser)   │       │ + AAC        │
   │AudioEnc  │        │              │       │              │
   └──────────┘        └──────────────┘       └──────────────┘
```

### 2.3 Integration Model: Hybrid B → C

**Phase 1 (Option B — Hybrid):** Keep FFmpeg for final mux/encode and complex filter graphs. Introduce C++ WASM module for:
- Audio DSP pipeline (trim, fade, resample, mix)
- Fast frame buffer pool management
- Simple crossfade frame blending (CPU SIMD)

**Phase 2 (Option C — Full Engine):** As the C++ layer grows, move per-clip video processing out of FFmpeg filter_complex and into a WebGPU+C++ pixel pipeline. FFmpeg is retained only for:
- Container muxing (when mp4-muxer can't handle a feature)
- Exotic codec support (fallback)
- Audio encoding AAC (if AudioEncoder unavailable)

---

## 3. C++ Media Engine Design

### 3.1 Directory Structure

```
media-engine/
├── CMakeLists.txt              # Emscripten toolchain
├── build.sh                    # Dev build script
├── build-prod.sh               # Release build (-O3, -flto)
├── src/
│   ├── bindings.cpp            # Embind JS ↔ C++ surface
│   ├── engine.cpp / .h         # Core orchestration
│   ├── audio/
│   │   ├── audio_processor.cpp # Trim, fade, resample, mix
│   │   ├── audio_processor.h
│   │   └── resampler.cpp       # Lightweight polyphase resampler
│   ├── video/
│   │   ├── frame_buffer.cpp    # SharedArrayBuffer frame pool
│   │   ├── frame_buffer.h
│   │   └── compositor.cpp      # Simple CPU overlay/fade
│   └── utils/
│       ├── logger.cpp          # Ring buffer mirroring ffmpegService
│       └── simd_helpers.h      # WASM SIMD128 wrappers
└── dist/                       # Generated .wasm + .js glue
    ├── media-engine.js
    └── media-engine.wasm
```

### 3.2 Build Integration

#### Emscripten Toolchain (CMakeLists.txt)

```cmake
cmake_minimum_required(VERSION 3.16)
project(media-engine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Emscripten-specific flags
set(EMSCRIPTEN_FLAGS
    "-O3"
    "-flto"
    "-s WASM=1"
    "-s ALLOW_MEMORY_GROWTH=1"
    "-s INITIAL_MEMORY=64MB"
    "-s MAXIMUM_MEMORY=512MB"
    "-s EXPORT_ES6=1"
    "-s MODULARIZE=1"
    "-s EXPORT_NAME='createMediaEngine'"
    "-s ENVIRONMENT='web'"
    "-s USE_PTHREADS=0"          # Start without threads; add later
    "-s FILESYSTEM=0"            # We manage our own buffers
    "-s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','getValue','setValue','writeArrayToMemory']"
    "-s EXPORTED_FUNCTIONS=['_malloc','_free']"
    "-msimd128"                  # Enable WASM SIMD128
    "--bind"                     # Embind
    "--no-entry"
)

add_executable(media-engine
    src/bindings.cpp
    src/engine.cpp
    src/audio/audio_processor.cpp
    src/video/frame_buffer.cpp
    src/video/compositor.cpp
    src/utils/logger.cpp
)

target_compile_options(media-engine PRIVATE ${EMSCRIPTEN_FLAGS})
target_link_options(media-engine PRIVATE ${EMSCRIPTEN_FLAGS})
```

#### Vite Integration

Add a build step to `package.json`:

```json
{
  "scripts": {
    "build:cpp": "cd media-engine && mkdir -p build && cd build && emcmake cmake .. && emmake make -j$(nproc)",
    "build:cpp:prod": "cd media-engine && ./build-prod.sh",
    "postinstall": "npm run build:cpp",
    "dev": "vite",
    "build": "npm run build:cpp:prod && vite build"
  }
}
```

And in `vite.config.ts`, copy the WASM artifact to `public/`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync } from 'fs';

// Ensure media-engine artifacts are in public/ for dev + build
const MEDIA_ENGINE_SRC = './media-engine/dist';
const MEDIA_ENGINE_DST = './public/media-engine';

try { cpSync(MEDIA_ENGINE_SRC, MEDIA_ENGINE_DST, { recursive: true, force: true }); } catch {}

export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: 'localhost',
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // ...
});
```

### 3.3 Memory + Threading Model

**Phase 1 — No pthreads:**
- Use a single WASM instance with `ALLOW_MEMORY_GROWTH`.
- All buffers are pre-allocated JS `ArrayBuffer` / `SharedArrayBuffer` passed to C++ via `ccall` pointer arguments.
- No Emscripten filesystem. We pass raw pointers.

**Phase 2 — Pthreads (if needed):**
- Enable `-s USE_PTHREADS=1` and `-s PTHREAD_POOL_SIZE=4`.
- Requires COOP/COEP (already satisfied).
- Use for parallel audio resampling of multiple clips.

**Cleanup discipline (mirroring ffmpegService):**
- C++ engine exposes `engine.reset()` that frees all pooled buffers and resets logger.
- JS wrapper (`cppMediaService.ts`) calls `reset()` on every render completion/failure, matching `aggressiveCleanupFFmpegVFS()`.

### 3.4 Debuggability

Mirror ffmpegService's excellent log capture:

```cpp
// C++ side (logger.cpp)
static std::array<std::string, 300> g_logRing;
static size_t g_logHead = 0;

void cppLog(const char* level, const char* msg) {
    g_logRing[g_logHead % g_logRing.size()] =
        std::string("[") + level + "] " + msg;
    g_logHead++;
    // Also EM_ASM console.log
    EM_ASM({ console.log('[MediaEngine]', UTF8ToString($0)); }, msg);
}
```

Exposed to JS:
```cpp
EMSCRIPTEN_BINDINGS(media_engine) {
    emscripten::function("getLogs", &getLogs);
    emscripten::function("getLastError", &getLastError);
    emscripten::function("clearLogs", &clearLogs);
}
```

---

## 4. WebGPU Acceleration Opportunities

### 4.1 Priority Matrix

| Feature | Priority | Approach | Effort | Impact |
|---------|----------|----------|--------|--------|
| **Real-time Preview** | 🔴 P0 | WebCodecs decode → WebGPU texture → WGSL shader → canvas | 3-4 days | **Massive** — users see fades/transitions live |
| **GPU Export Compositor** | 🔴 P0 | WebGPU offscreen + frame loop (not 1× real-time) → VideoEncoder | 4-5 days | **Massive** — replaces slow Canvas2D path |
| **Audio-reactive shaders** | 🟡 P1 | WGSL compute/fragment shaders driven by audio FFT | 2 days | High — better than 2D canvas glow |
| **Transition shaders** | 🟡 P1 | WGSL dissolve/motion on GPU textures | 2-3 days | High — xfade in shader, not FFmpeg |
| **Thumbnail GPU extraction** | 🟢 P2 | WebCodecs decode keyframes → GPU → downscale | 1-2 days | Medium |
| **PiP compositing** | 🟢 P2 | Multi-texture rendering with blend state | 2 days | Medium |

### 4.2 WebGPU ↔ C++ Communication Model

**Decision:** WebGPU stays in JS. C++ handles what JS cannot do efficiently.

```
┌──────────────────────────────────────────────────────────────┐
│                        JS Thread                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐  │
│  │WebCodecs    │───►│VideoFrame   │───►│GPUExternalTexture│  │
│  │VideoDecoder │    │             │    │  (zero-copy)     │  │
│  └─────────────┘    └─────────────┘    └────────┬────────┘  │
│                                                  │            │
│  ┌───────────────────────────────────────────────┘            │
│  ▼                                                             │
│  WebGPU Render Pass (WGSL shaders: fade, color, transitions)   │
│  │                                                             │
│  ▼                                                             │
│  GPUCanvasContext.present()  OR  copyTextureToBuffer()         │
│                                                                  │
│  Audio: C++ WASM engine processes AudioData → Float32Array     │
│         passed to Web Audio Analyser or AudioEncoder            │
└──────────────────────────────────────────────────────────────┘
```

**Why this split?**
- WebGPU API is JS-only (no stable C++ bridge in browser).
- VideoFrame → GPUExternalTexture is a zero-copy browser optimization we cannot replicate from C++.
- C++ excels at audio DSP, memory pool management, and SIMD frame packing.
- JS excels at GPU command submission and browser media API orchestration.

---

## 5. Implementation Roadmap

### Phase 1: Foundation (Week 1-2) — WebGPU Preview

**Goal:** A live preview panel showing the selected clip with real-time fade, color adjustments, and basic transitions.

| Task | Files | Details |
|------|-------|---------|
| 1.1 WebGPU Preview Engine | `src/webgpu/previewEngine.ts` | Initialize WebGPU device, shader modules, bind group layouts |
| 1.2 Video Decoder → GPU | `src/webgpu/videoTextureSource.ts` | Wrap `VideoDecoder` + `GPUExternalTexture` with frame queue |
| 1.3 WGSL Shaders | `src/webgpu/shaders/` | `fade.wgsl`, `color.wgsl`, `letterbox.wgsl` |
| 1.4 Preview Integration | `src/components/Preview.tsx` | Replace `<video>` with `<canvas>` when WebGPU available |
| 1.5 Fallback | `src/webgpu/previewEngine.ts` | Graceful fallback to `<video>` if WebGPU unavailable |

**Deliverable:** Preview.tsx shows live fades when user drags fade sliders.

### Phase 2: C++ Audio Engine (Week 2-3)

**Goal:** Offload audio processing from FFmpeg filter_complex to C++ WASM.

| Task | Files | Details |
|------|-------|---------|
| 2.1 Emscripten scaffold | `media-engine/CMakeLists.txt` | Build pipeline integrated with Vite |
| 2.2 Audio Processor | `media-engine/src/audio/audio_processor.cpp` | Trim, fade, 44.1kHz resample, stereo mix |
| 2.3 JS Service Wrapper | `src/cpp/cppMediaService.ts` | Singleton mirroring ffmpegService patterns |
| 2.4 Integration point | `src/ffmpeg/ffmpegService.ts` | `muxVideoWithAudio` uses C++ audio when available |
| 2.5 Tests | `src/cpp/cppMediaService.test.ts` | Round-trip audio processing tests |

**Deliverable:** Canvas/WebCodecs paths use C++ for audio; FFmpeg audio filter graph load reduced.

### Phase 3: GPU Export Compositor (Week 3-5)

**Goal:** Replace the 1× real-time Canvas2D path with a WebGPU compositor that can render at 5-10× speed.

| Task | Files | Details |
|------|-------|---------|
| 3.1 Offscreen WebGPU canvas | `src/webgpu/exportCompositor.ts` | `GPUCanvasContext` on offscreen canvas |
| 3.2 Frame-accurate loop | `src/webgpu/exportCompositor.ts` | Manual frame clock (not rAF) driving decoder at target FPS |
| 3.3 Transition shaders | `src/webgpu/shaders/transitions.wgsl` | Dissolve, motion-smoothleft on GPU |
| 3.4 Text overlay rasterization | `src/webgpu/textRasterizer.ts` | Offscreen 2D canvas text → GPU texture |
| 3.5 MediaRecorder capture | `src/webgpu/exportCompositor.ts` | Capture WebGPU canvas via `canvas.captureStream()` |
| 3.6 Audio sync | `src/webgpu/exportCompositor.ts` | Ensure video frame timestamp aligns with C++ audio output |

**Deliverable:** `useCanvasRenderer` toggle now runs at 5-10× speed with WebGPU backend.

### Phase 4: Full Pipeline Optimization (Week 5-8)

**Goal:** WebGPU + C++ path handles transitions, PiP, and text overlays without FFmpeg re-encode.

| Task | Details |
|------|---------|
| 4.1 Zero-copy frame pooling | SharedArrayBuffer pools managed by C++, textured by WebGPU |
| 4.2 C++ frame packing | YUV→RGBA conversion in SIMD for frames that can't use GPUExternalTexture |
| 4.3 WebCodecs VideoEncoder integration | Encode directly from GPU texture without canvas readback |
| 4.4 mp4-muxer chunking | Stream chunks during encode to bound memory |
| 4.5 FFmpeg fallback refinement | Only use FFmpeg for exotic codecs or when WebCodecs fails |

---

## 6. Code Sketches & Interfaces

### 6.1 C++ ↔ JS Binding Surface (Embind)

```cpp
// media-engine/src/bindings.cpp
#include <emscripten/bind.h>
#include "engine.h"
#include "audio/audio_processor.h"
#include "video/frame_buffer.h"

using namespace emscripten;

EMSCRIPTEN_BINDINGS(media_engine) {
    // --- Audio Processor ---
    class_<AudioProcessor>("AudioProcessor")
        .constructor<>()
        .function("loadClip", &AudioProcessor::loadClip)
        .function("setTrim", &AudioProcessor::setTrim)
        .function("setFade", &AudioProcessor::setFade)
        .function("setTargetSampleRate", &AudioProcessor::setTargetSampleRate)
        .function("process", &AudioProcessor::process)
        .function("getOutputBuffer", &AudioProcessor::getOutputBuffer)
        .function("getOutputFrameCount", &AudioProcessor::getOutputFrameCount)
        .function("reset", &AudioProcessor::reset);

    // --- Audio Mixing ---
    class_<AudioMixer>("AudioMixer")
        .constructor<int, int>() // inputs, sampleRate
        .function("addInput", &AudioMixer::addInput)
        .function("setCrossfade", &AudioMixer::setCrossfade)
        .function("mix", &AudioMixer::mix)
        .function("getOutputBuffer", &AudioMixer::getOutputBuffer);

    // --- Frame Buffer Pool ---
    class_<FrameBufferPool>("FrameBufferPool")
        .constructor<int, int, int>() // width, height, count
        .function("acquire", &FrameBufferPool::acquire)
        .function("release", &FrameBufferPool::release)
        .function("getPointer", &FrameBufferPool::getPointer);

    // --- Engine / Diagnostics ---
    class_<MediaEngine>("MediaEngine")
        .constructor<>()
        .function("reset", &MediaEngine::reset)
        .function("getLogs", &MediaEngine::getLogs)
        .function("getLastError", &MediaEngine::getLastError)
        .function("clearLogs", &MediaEngine::clearLogs);

    function("createMediaEngine", &createMediaEngine);
}
```

### 6.2 JS Service Wrapper (mirroring ffmpegService)

```typescript
// src/cpp/cppMediaService.ts
import type { Clip, ExportSettings } from '../types';

interface CppMediaEngineModule {
  AudioProcessor: new () => AudioProcessor;
  AudioMixer: new (inputs: number, sampleRate: number) => AudioMixer;
  FrameBufferPool: new (w: number, h: number, count: number) => FrameBufferPool;
  MediaEngine: new () => MediaEngine;
}

let modulePromise: Promise<CppMediaEngineModule> | null = null;
let engineInstance: MediaEngine | null = null;

/** Ring-buffer logs from C++ side */
const MAX_CPP_LOGS = 300;
let cppLogBuffer: string[] = [];

export async function ensureCppMediaEngine(): Promise<CppMediaEngineModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const create = (await import('../../media-engine/dist/media-engine.js')).default;
    const mod = await create();
    return mod as CppMediaEngineModule;
  })();
  return modulePromise;
}

export async function resetCppMediaEngine(): Promise<void> {
  if (engineInstance) {
    engineInstance.reset();
    engineInstance = null;
  }
  modulePromise = null;
  cppLogBuffer = [];
}

export async function processAudioClip(
  clip: Clip,
  pcmData: Float32Array,
  sampleRate: number,
): Promise<Float32Array> {
  const mod = await ensureCppMediaEngine();
  const proc = new mod.AudioProcessor();
  proc.loadClip(pcmData.byteOffset, pcmData.length, sampleRate);
  proc.setTrim(clip.trimStart, Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration);
  proc.setFade(clip.audioFadeIn, clip.audioFadeOut);
  proc.setTargetSampleRate(44100);
  proc.process();
  const outFrames = proc.getOutputFrameCount();
  const outPtr = proc.getOutputBuffer();
  // Copy from WASM heap
  const result = new Float32Array(outFrames * 2); // stereo
  // ... HEAPF32 copy logic ...
  proc.reset();
  return result;
}
```

### 6.3 WebGPU Preview Renderer

```typescript
// src/webgpu/previewEngine.ts
export interface PreviewEngineOptions {
  canvas: HTMLCanvasElement;
  width?: number;
  height?: number;
}

export class PreviewEngine {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private bindGroupLayout: GPUBindGroupLayout;
  private uniformBuffer: GPUBuffer;
  private videoTexture: GPUTexture | null = null;
  private externalTexture: GPUExternalTexture | null = null;

  // Uniforms: fadeIn, fadeOut, duration, elapsed, opacity
  private uniformData = new Float32Array(8);

  static async create(options: PreviewEngineOptions): Promise<PreviewEngine> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const context = options.canvas.getContext('webgpu')!;
    context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
    });
    return new PreviewEngine(device, context, options);
  }

  async renderFrame(
    videoFrame: VideoFrame | null,
    elapsed: number,
    duration: number,
    fadeIn: number,
    fadeOut: number,
    opacity: number,
  ): Promise<void> {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });

    // Update uniforms
    this.uniformData[0] = fadeIn;
    this.uniformData[1] = fadeOut;
    this.uniformData[2] = duration;
    this.uniformData[3] = elapsed;
    this.uniformData[4] = opacity;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    // Import VideoFrame as external texture (zero-copy)
    if (videoFrame) {
      this.externalTexture = this.device.importExternalTexture({ source: videoFrame });
    }

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.externalTexture ?? this.placeholderTexture.createView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6); // Full-screen triangle pair
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
```

### 6.4 WGSL Fade + Letterbox Shader

```wgsl
// src/webgpu/shaders/preview.wgsl
@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct Uniforms {
  fadeIn: f32,
  fadeOut: f32,
  duration: f32,
  elapsed: f32,
  opacity: f32,
};

struct VertexOutput {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
  // Full-screen triangle covering clip space
  var out: VertexOutput;
  let x = f32(idx % 2u) * 2.0 - 1.0; // 0→-1, 1→1
  let y = f32(idx / 2u) * 2.0 - 1.0; // 0→-1, 1→1, 2→1
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, -y * 0.5 + 0.5);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Sample video (YUV→RGBA conversion handled by external texture)
  var color = textureSampleBaseClampToEdge(videoTexture, videoSampler, in.uv);

  // Apply opacity (for PiP overlays)
  color.a *= u.opacity;

  // Compute fade alpha
  var fadeAlpha = 1.0;
  if (u.fadeIn > 0.0 && u.elapsed < u.fadeIn) {
    fadeAlpha = u.elapsed / u.fadeIn;
  }
  if (u.fadeOut > 0.0 && u.elapsed > (u.duration - u.fadeOut)) {
    fadeAlpha = min(fadeAlpha, (u.duration - u.elapsed) / u.fadeOut);
  }

  // Apply fade as black overlay
  color.rgb *= fadeAlpha;

  return color;
}
```

### 6.5 Evolved `calculateRenderPlan` → `selectRenderBackend`

```typescript
// src/utils/renderBackend.ts
export type Backend =
  | 'lossless-concat'
  | 'ffmpeg-effects'
  | 'ffmpeg-transitions'
  | 'ffmpeg-pip'
  | 'webcodecs-simple'
  | 'webcodecs-gpu'
  | 'canvas-gpu'
  | 'canvas-cpu';

export interface BackendSelection {
  backend: Backend;
  reason: string;
  description: string;
  willReencode: boolean;
  /** Whether this backend supports live preview */
  supportsLivePreview: boolean;
}

export async function selectRenderBackend(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  settings: ExportSettings,
  caps: BrowserCapabilities,
): Promise<BackendSelection> {
  const hasPip = clips.some((c) => (c.layerIndex ?? 0) > 0);
  const hasTransitions = transitions.some((t) => t.type !== 'none' && t.duration > 0);
  const hasText = textOverlays.length > 0;
  const hasEffects = clips.some((c) =>
    c.videoFadeIn > 0 || c.videoFadeOut > 0 || c.audioFadeIn > 0 || c.audioFadeOut > 0 || c.kind === 'audio'
  );

  // Priority 1: WebGPU + WebCodecs for simple cases (no transitions/PiP/text)
  if (caps.webgpu && caps.webcodecs && !hasTransitions && !hasPip && !hasText) {
    return {
      backend: 'webcodecs-gpu',
      reason: 'WebGPU + WebCodecs available, no complex effects',
      description: 'GPU-accelerated encode with WebGPU compositing',
      willReencode: true,
      supportsLivePreview: true,
    };
  }

  // Priority 2: WebGPU canvas for audio-reactive / simple effects
  if (caps.webgpu && !hasTransitions && !hasPip && !hasText) {
    return {
      backend: 'canvas-gpu',
      reason: 'WebGPU available, canvas path with GPU compositing',
      description: 'WebGPU canvas compositing + MediaRecorder',
      willReencode: true,
      supportsLivePreview: true,
    };
  }

  // Fallback to existing logic...
  if (hasPip) {
    return { backend: 'ffmpeg-pip', reason: 'PiP detected', description: 'FFmpeg PiP compositing', willReencode: true, supportsLivePreview: false };
  }
  if (hasTransitions) {
    return { backend: 'ffmpeg-transitions', reason: 'Transitions detected', description: 'FFmpeg xfade transitions', willReencode: true, supportsLivePreview: false };
  }
  if (hasText) {
    return { backend: 'ffmpeg-effects', reason: 'Text overlays', description: 'FFmpeg re-encode + drawtext', willReencode: true, supportsLivePreview: false };
  }
  if (hasEffects || clips.length > 1) {
    return { backend: 'ffmpeg-effects', reason: 'Effects or multi-clip normalization', description: 'FFmpeg two-pass re-encode', willReencode: true, supportsLivePreview: false };
  }

  return { backend: 'lossless-concat', reason: 'Single clean clip', description: 'Lossless stream copy', willReencode: false, supportsLivePreview: true };
}
```

---

## 7. Risks, Compatibility & Debugging

### 7.1 Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| WebGPU API churn / vendor bugs | Medium | Feature-detect aggressively; fallback to Canvas2D or FFmpeg |
| VideoFrame → GPUExternalTexture unsupported on some GPUs | Medium | Fallback to `copyExternalImageToTexture` or CPU readback |
| Emscripten build friction in CI | Medium | Docker image with EMSDK; build artifacts committed as fallback |
| SharedArrayBuffer + COOP/COEP breakage | Low | Already required for FFmpeg; maintain `.htaccess` + Vite headers |
| Memory growth in WebGPU | Medium | Use `destroy()` on textures/buffers aggressively; frame pools |
| Audio sync drift in GPU paths | Medium | Drive frame loop from audio clock; use `timestamp` on VideoFrame |

### 7.2 Browser Compatibility

| Feature | Chrome | Edge | Firefox | Safari |
|---------|--------|------|---------|--------|
| WebGPU | ✅ 113+ | ✅ 113+ | 🔄 Nightly | ✅ 17+ (limited) |
| WebCodecs VideoEncoder | ✅ 94+ | ✅ 94+ | ❌ No | ❌ No |
| WebCodecs VideoDecoder | ✅ 94+ | ✅ 94+ | ❌ No | ❌ No |
| VideoFrame | ✅ 94+ | ✅ 94+ | ❌ No | ❌ No |
| GPUExternalTexture | ✅ 113+ | ✅ 113+ | 🔄 Nightly | ✅ 17+ |
| requestVideoFrameCallback | ✅ 83+ | ✅ 83+ | ❌ No | ✅ 15+ |
| SharedArrayBuffer | ✅ +COOP | ✅ +COOP | ✅ +COOP | ✅ +COOP |

**Strategy:** Treat WebGPU + WebCodecs as a **progressive enhancement** for Chromium-based browsers. Firefox and Safari continue using the existing FFmpeg path (which already works).

### 7.3 Debugging Strategy

1. **Mirror ffmpegService's log discipline:**
   - C++ engine maintains a 300-line ring buffer.
   - JS wrappers prefix logs with `[CppMedia]` / `[WebGPU]` / `[WebCodecs]`.
   - `handleCopyDebugInfo` in App.tsx includes all three log buffers.

2. **Shader hot-reload:**
   - In dev mode, fetch WGSL from `/shaders/*.wgsl` instead of inlining.
   - Use `console.error` with full shader source on compilation failure.

3. **WebGPU validation:**
   - Always request device with `requiredFeatures` explicit list.
   - Enable Chrome flag `--enable-dawn-features=allow_unsafe_apis` for development.

4. **Performance profiling:**
   - Use `GPUCommandEncoder` timestamp queries (where supported) to measure GPU frame time.
   - Compare against Canvas2D path using `performance.measure()`.

---

## 8. Quick Wins (< 1 Day)

### 8.1 Add WebGPU capability to `detectCapabilities`

Already detects `webgpu` boolean. Expand to test actual device creation:

```typescript
// src/utils/feature-detector.ts
let webgpuUsable = false;
if ('gpu' in navigator) {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter?.requestDevice();
    webgpuUsable = !!device;
    device?.destroy();
  } catch { /* ignore */ }
}
```

### 8.2 Live fade preview in Inspector (Canvas2D)

Before WebGPU is ready, enhance the Inspector's fade preview from a CSS bar to a tiny Canvas2D loop:

```typescript
// In Inspector.tsx, replace <FadePreview /> with <FadeVideoPreview />
// Draws a single frame from the clip's video with fade overlay applied.
// Uses <video>.currentTime = trimStart + fadeDuration/2 to show representative frame.
```

**Effort:** 2-3 hours. **Value:** Users see *something* before render.

### 8.3 Use `requestVideoFrameCallback` in existing WebCodecs path

The WebCodecs path already has `requestVideoFrameCallback` support but also has a seek-step fallback. Ensure the fast path is always taken when available (it is — code is already there, just verify it's working).

### 8.4 C++ build scaffolding

Set up the `media-engine/` directory with CMakeLists.txt and a single `add(2,2)` binding. Integrate into `package.json` build. Prove the pipeline works end-to-end.

**Effort:** 4-6 hours. **Value:** Unblocks all C++ work.

### 8.5 Audio-only clip fast path

Audio-only clips currently synthesize a black video via FFmpeg `color=c=black`. In the WebCodecs path, this is already a single black frame. In the C++ path, we can generate silent audio even faster. Small win, easy to implement.

---

## Appendix: Files to Create / Modify

### New Files

```
media-engine/
├── CMakeLists.txt
├── build.sh
├── build-prod.sh
└── src/
    ├── bindings.cpp
    ├── engine.cpp / .h
    ├── audio/
    │   ├── audio_processor.cpp / .h
    │   └── resampler.cpp / .h
    ├── video/
    │   ├── frame_buffer.cpp / .h
    │   └── compositor.cpp / .h
    └── utils/
        ├── logger.cpp / .h
        └── simd_helpers.h

src/cpp/
├── cppMediaService.ts
└── cppMediaService.test.ts

src/webgpu/
├── previewEngine.ts
├── exportCompositor.ts
├── videoTextureSource.ts
├── textRasterizer.ts
├── shaders/
│   ├── preview.wgsl
│   ├── transitions.wgsl
│   └── audioReactive.wgsl
└── webgpuUtils.ts
```

### Modified Files

```
src/App.tsx                          # Add WebGPU preview state, backend routing
src/components/Preview.tsx           # Integrate WebGPU preview canvas
src/components/Inspector.tsx         # Live fade preview hooks
src/components/Toolbar.tsx           # Show backend badge (WebGPU / C++ / FFmpeg)
src/ffmpeg/ffmpegService.ts          # Use C++ audio when available
src/utils/hybrid-encoder.ts          # Route to WebGPU backend
src/utils/feature-detector.ts        # Expand capability detection
src/utils/calculateRenderPlan.ts     # Evolve to selectRenderBackend
vite.config.ts                       # Copy media-engine dist to public/
package.json                         # Add build:cpp scripts
```

---

## Summary for Noah

**The existing codebase is well-architected.** The FFmpeg service's error handling, cleanup discipline, and diagnostic logging are production-grade. The hybrid encoder's fallback chain (Canvas → WebCodecs → FFmpeg) is the right pattern.

**The highest-value next step is WebGPU live preview.** Users currently render completely blind — they cannot see fades, transitions, or text overlays before export. A WebGPU preview pipeline (WebCodecs decode → GPU shader → canvas) solves this and lays the foundation for the GPU export compositor.

**The C++ layer should start small and focused:** audio DSP (trim, fade, resample, mix). This immediately offloads work from FFmpeg's filter_complex and gives you a SIMD-accelerated audio path. Expand to frame buffer management once the audio pipeline is solid.

**Keep FFmpeg as the universal fallback.** Do not try to replace it for exotic codecs, container features, or complex filter graphs. The goal is to *bypass* FFmpeg for the 80% of simple/effects renders, not eliminate it.
