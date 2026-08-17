# Repository Guidelines

## Project Structure & Module Organization

This is a React 18 + TypeScript Vite app for browser-based clip editing and MP4 rendering with FFmpeg WebAssembly. Source lives in `src/`: `main.tsx` bootstraps React, `App.tsx` owns app-level state, `components/` contains UI panels, `ffmpeg/` contains FFmpeg WASM orchestration, `utils/` contains media/project/render helpers, `hooks/` contains shared React hooks, and `types/` holds shared TypeScript types. Tests are colocated with source as `*.test.ts` or `*.test.tsx`. Static deployment assets live in `public/`; built output goes to `dist/` and should be treated as generated.

## Build, Test, and Development Commands

- `npm install` (or `npm ci` for a clean/CI install): install dependencies for local development.
- `npm run dev`: start the Vite dev server with the headers needed for FFmpeg WASM.
- `npm run typecheck`: run `tsc --noEmit`, matching CI behavior. Run this after any TypeScript change.
- `npm test -- --run`: run the Vitest suite once, matching CI behavior.
- `npm run test:coverage`: run tests with coverage reporting.
- `npm run build`: produce the production build in `dist/`.
- `npm run preview`: serve the built app locally for verification.
- `npm run deploy`: build, then upload `dist/` using `deploy.py`.
- `npm run build:audio-analysis`: rebuild the audio FFT WASM module (`public/wasm/`) via Emscripten.

## Coding Style & Naming Conventions

Use TypeScript with strict checking. Follow the existing style: two-space indentation, single quotes, semicolons, named exports for reusable components/functions, and `PascalCase` for React components such as `ClipLibrary.tsx`. Utilities should use descriptive `camelCase` names, for example `calculateRenderPlan` or `serializeProjectWithMedia`. Prefer the `@/` alias for imports from `src` when it improves readability. Keep comments focused on non-obvious behavior, especially around FFmpeg, memory cleanup, and browser media APIs.

## Testing Guidelines

Vitest runs in the `happy-dom` environment and includes `src/**/*.test.ts` and `src/**/*.test.tsx`. Add tests beside the module being changed, using names like `project.test.ts` or `ffmpegService.load.test.ts`. Cover render-plan decisions, project serialization, transition logic, and failure paths when editing shared utilities. Before submitting, run `npm run typecheck`, `npm test -- --run`, and `npm run build`.

## Commit & Pull Request Guidelines

Recent history uses short imperative commits, sometimes with conventional prefixes, for example `fix: harden Extract Audio...` or `Chore: improve FFmpeg robustness...`. Keep commits focused and explain user-visible behavior changes. Pull requests should include a concise summary, test results, linked issues when applicable, and screenshots or recordings for UI changes. Note any changes affecting deployment headers, remote storage endpoints, FFmpeg loading, or generated media behavior.

## Security & Configuration Tips

Do not commit secrets, storage auth tokens, or private endpoint credentials. Preserve COOP/COEP headers in Vite and Apache configuration because SharedArrayBuffer and FFmpeg WASM depend on them.

## Cursor Cloud specific instructions

Single-service product: a React + TypeScript Vite frontend (no backend to run; `contabo_storage_manager/` is an optional external storage backend, not started here). Standard commands live in `package.json` / README (`npm test -- --run`, `npm run build`, `npm run dev`, `npm run preview`).

Non-obvious caveats:

- `npm ci` works against the committed `package-lock.json`. If you add/remove/upgrade a dependency, run `npm install` and commit the updated `package-lock.json` in the same change so `npm ci` stays in sync — it previously drifted (missing optional `@esbuild/*` platform packages) and broke CI.
- `npm run dev` does not render in a CSP-enforcing browser as-is. `index.html` ships a static `Content-Security-Policy` meta tag with `script-src 'self' 'wasm-unsafe-eval'` (no `'unsafe-inline'`), which blocks Vite's injected inline React-refresh/HMR preamble script and leaves a blank page with `@vitejs/plugin-react can't detect preamble` console errors. To run/verify the app in the browser, use the production build instead: `npm run build` then `npm run preview` (serves on `http://localhost:4173/`, no inline scripts, CSP-clean). Do not relax the CSP just to make dev mode load unless that is the actual task.
- FFmpeg WASM needs cross-origin isolation; both the dev and preview servers already set the required COOP/COEP headers, so use those servers rather than a generic static server.

## Text overlay fonts

Text overlays (`TextOverlay`) carry an optional `font` id (string). When omitted or unknown on load, the overlay falls back to the default Roboto Regular for backward compatibility with old projects.

Bundled fonts live in `public/fonts/` and are registered in one place:

- `src/utils/textOverlay.ts` — `BUNDLED_FONTS`, `getBundledFont(id)`, `resolveFontFileForOverlay`, `buildDrawtextFilter`
- `src/ffmpeg/core.ts` — `ensureFont` / `ensureFontsForOverlays`, `FONT_URL_BY_VIRTUAL` (virtual name → fetch URL)
- `src/utils/canvas-renderer.ts` — `drawTextLayer` sets `ctx.font` using the CSS `familyName`
- `src/styles/fonts.css` — `@font-face` declarations (required for Canvas2D metrics)
- `src/utils/project.ts` — `applyProjectData` resolves font ids with safe fallback; `serializeProject` round-trips the id as-is

Adding a font:

1. Place a license-safe `.ttf` in `public/fonts/`.
2. Add an entry to `BUNDLED_FONTS` with stable `id`, display `label`, CSS `familyName`, `fileName`, and `virtualName` (the name written to the FFmpeg VFS).
3. Add a matching `@font-face` in `src/styles/fonts.css` pointing at `/fonts/<fileName>`.
4. If the virtual name is new, add a URL mapping in `FONT_URL_BY_VIRTUAL` in `core.ts`.
5. Add or update tests in `textOverlay.test.ts` (filter strings) and `project.test.ts` (round-trip + unknown fallback).
6. Update docs (README table + this section).

Current small set (license notes):
- Roboto Regular/Bold — Apache License 2.0 (Google)
- DejaVu Serif / Sans Mono — Bitstream Vera fonts (public domain-like) + DejaVu additions (free)

Never embed user-supplied custom fonts (out of scope).

## Audio analysis WASM (FFT / beats)

Real-time and offline audio features use a small Emscripten module (kissfft, BSD-3-Clause) that produces frequency-band energy and beat onset envelopes for WebGPU uniforms and timeline markers.

### Layout

- `native/audio_analysis/` — C++ source + vendored kissfft; rebuild with `npm run build:audio-analysis` (requires `emcc`)
- `public/wasm/audio_analysis.{js,wasm}` — committed build artifacts (~14 KB gzipped WASM)
- `src/wasm/audioAnalysis.ts` — lazy loader + typed analyzer bindings (graceful disable on load failure)
- `src/wasm/offlineAnalysis.ts` — full-buffer / clip-load analysis → `beatTimestamps` / `bpmEstimate` on `Clip`
- `src/wasm/audioAnalysisWorker.ts` + `audioAnalysisClient.ts` — Worker offload (keep main-thread long tasks < 16 ms)
- `src/wasm/audioReactiveUniforms.ts` — shared `AudioReactive` uniform shape + WGSL snippet docs
- `src/webgpu/previewEngine.ts` — `setAudioReactive({ bass, mid, treble, beat })` writes uniform slots 13–16
- `src/webgpu/shaders/preview.wgsl` — `Uniforms.bass|mid|treble|beat` + optional warm lift
- `src/utils/beatMarkers.ts` + Timeline ruler — read-only beat overlay when metadata is present
- `src/utils/canvas-renderer.ts` — `setWasmBassLevel()` for export parity with the same analysis source

### Adding analysis-driven shader uniforms

1. Produce energies via `createAudioAnalyzer` / worker `analyzeFrame` (or offline hop results).
2. Call `previewEngine.setAudioReactive({ bass, mid, treble, beat })` each preview frame (or clear with defaults).
3. In WGSL, read `u.bass` / `u.mid` / `u.treble` / `u.beat` (already on the preview uniform struct). For new transition shaders, either mirror those fields or include the snippet from `AUDIO_REACTIVE_WGSL_SNIPPET`.
4. Keep zeros when WASM is unavailable — shaders must remain no-ops (no crash / no visual glitch).

Do not vendor user-supplied DSP plugins; stick to kissfft (or another OSI-approved FFT) inside `native/audio_analysis/`.

## gpu-chores (import / library pixel work)

TypedArray image chores for clip import and library UX — luminance histogram, downsample-for-thumbs, optional blur. This is **not** FFmpeg encode/decode, **not** kissfft audio analysis, and **not** the WebGPU preview compositor (#114 / #118 / #187).

### Layout

- `src/gpu-chores/` — local stub of the shared `runJob({ op, prefer: 'auto' })` API
- Kernels: `luma_histogram_bt709` (256-bin Rec.709, Chromashift-compatible), `downsample_2d` (bilinear thumbs), `separable_blur` (UI soft masks)
- Backend order: adopt the **existing** preview `GPUDevice` (never `requestDevice()` from chores). If that device lives in the OffscreenCanvas preview worker, main thread posts an `ImageBitmap` (`chore-jobs`) and reads back aggregates only. Then chores Worker (TS golden) → main-thread TS. WebGL2 is not used (one GPU API per working set).
- Break-even: GPU only at ≥ 1 megapixel (`prefer: 'auto'`). Small stills stay CPU. Kill switch: `?no_gpu_compute`.
- Diagnostics: `gpuComputeAvailable()` / `formatGpuChoreDiagnostics()` (inspector + Copy Debug). **WebGPU is required for GPU preview**; a failed adapter/device probe hard-fails the preview pane (Canvas2D is not the GPU fallback). Chores never `requestDevice()` after a failed probe.

Do not keep a second WebGL context for histograms. Keep COOP/COEP and the production CSP unchanged (workers already allowed via `worker-src 'self' blob:`).

## Variable speed remapping (time stretch)

`automation.playbackRate` keyframes (existing `Keyframe` type — output-local seconds) remap timeline time to source time via ∫ rate(τ) dτ (`src/utils/timeRemap.ts`). Preview video samples frames at the remapped `sourceTime`; audio is pitch-preserved with a small WSOLA WASM module (not SoundTouch / LGPL).

### Layout

- `native/time_stretch/` — C++ WSOLA remap; rebuild with `npm run build:time-stretch` (requires `em++`)
- `public/wasm/time_stretch.{js,wasm}` — committed build artifacts
- `public/worklets/time-stretch-processor.js` — AudioWorklet for live constant-tempo stretch
- `src/wasm/timeStretch.ts` + `timeStretchWorklet.ts` — lazy WASM / worklet bindings (JS OLA fallback)
- `src/utils/remapAudio.ts` + `remappedAudioCache.ts` — curve → remapped `AudioBuffer` for schedule / export premix
- `src/components/SpeedAutomationLane.tsx` — Cubase-style lane under the selected timeline clip
- Inspector **Speed (time remap)** `KeyframeMiniEditor` — same lane as volume/pan

When `playbackRate` automation is present, FFmpeg export uses the OfflineAudioContext premix path (same as volume/pan). Constant `clip.playbackRate` without a curve still uses `setpts` + chained `atempo`.

## Intercut generator (local FFmpeg)

Library macro that alternates two clips at a configurable (accelerating) cut rate and drops a new MP4 into the library. Planning lives in `src/utils/intercut.ts`.

`sourceClock`:
- `freezeHidden` (default) — only the visible source’s `inpoint`/`outpoint` advance; the hidden clip freezes and resumes (keeps offscreen frames).
- `parallel` — both playheads track output wall time (cutting to B at t shows B at trimStart+t; offscreen frames are skipped).

`consumeMode`:
- `targetDuration` (default) — fill `automation.totalDurationSec` (plus optional `tailDurationSec` on the landing clip).
- `entireSources` — drain the material budget: freezeHidden → len(A)+len(B); parallel → max(len(A), len(B)).

`forceFinalClip` (`A` / `B` / `auto`) overrides the last swapping-phase slot; `tailDurationSec` holds the landing clip after the last cut when material remains. `src/ffmpeg/intercutGenerator.ts` writes VFS files, optionally normalizes mismatched resolution/fps/codec, concatenates, then applies audio policy (`both` / `aOnly` / `silent`). Beat-sync uses `beatsInTrimWindow()` + stride vs Hz; faster-than-beat strobes fall back to raw Hz. Stream copy only when every slice is ≥ `INTERCUT_MIN_STREAM_COPY_SLICE_SEC` (0.5s). UI: `IntercutModal` from Clip Library **Create Intercut Clip**.

