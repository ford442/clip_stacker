# grok.md — Grok AI Assistant Guide for clip_stacker

> Read this first.

## Project Overview

**clip_stacker** is a browser-based video editing tool that lets users upload, trim, reorder, apply fade effects to, and merge multiple video/audio clips into a single MP4 file — all processed client-side using FFmpeg WebAssembly.

- **Purpose**: Lightweight, dependency-free (no server needed) video clip assembly.
- **Focus**: Clean UX for small-scale clip editing tasks — no server uploads, no accounts.

## Technology Stack

- React 18 + TypeScript
- Vite 5
- FFmpeg WebAssembly (`@ffmpeg/ffmpeg`)

## Grok Guidelines

- **Keep it in the browser**: All processing happens client-side. Do not introduce server-side rendering or backend dependencies.
- **UX clarity**: The interface should make the clip workflow obvious — upload → arrange → configure → render → download.
- **Performance awareness**: FFmpeg WASM is heavy. Minimize unnecessary re-encodes; prefer the lossless concat path when no fades are configured.
- **Reactivity**: React state drives the UI. Avoid direct DOM manipulation.
- **TypeScript strict**: All code must be properly typed; avoid `any`.

## Common Tasks

- Improve the Timeline UX (drag-and-drop reordering)
- Add waveform or thumbnail previews per clip
- Improve render progress feedback (progress bar)
- Add support for additional output formats
- Improve error handling and user messaging

## Notes

- FFmpeg core is loaded from CDN via `toBlobURL` — this requires an internet connection at runtime.
- SharedArrayBuffer is required; the server must send COOP/COEP headers. The Vite dev server handles this automatically.

## Error Handling & Diagnostics (post-2026 fixes)

Render and Extract Audio **never fail silently**:

- Every `ffmpeg.exec`, `writeFile`, and `readFile` is wrapped (`safeExec` / `safeWriteFile` / `safeReadFile` in ffmpegService.ts).
- The `on('log')` listener (previously filtered to only `time=`) **now records every line** to an in-memory ring buffer + console.
- An `on('error')` listener was added.
- Failures throw **augmented Errors** containing the operation label + the last 25 FFmpeg log lines + the specific error line (e.g. "No such filter", "matches no streams").
- `extractAudioToWav` and `mergeClips` have `try/finally` for guaranteed temp-file cleanup on error paths.
- `hybridMergeClips` chains fallback errors (canvas → webcodecs → FFmpeg) into the final message.
- UI catches always surface the full message in the status bar.
- **📋 Copy Debug** button (Toolbar) copies: current status, render plan, last 60 FFmpeg logs, last error log, clip count, UA, crossOriginIsolated flag. Perfect for bug reports.
- Pre-flight: zero-duration clips are rejected early for extract.

To debug a failure locally:
1. Click Render/Extract.
2. When it fails, click **📋 Copy Debug** (or open DevTools console).
3. Paste the report.

The old root causes (swallowed stderr, no try/catch context, narrow log filter) are eliminated while preserving the intelligent render plan + progress UX.
