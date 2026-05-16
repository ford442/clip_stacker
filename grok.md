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
