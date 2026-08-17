# gpu-chores

Local stub of the cross-app **gpu-chores** job API (`runJob({ op, prefer: 'auto' })`) for clip-import analysis and library thumbs.

This is **not**:

- FFmpeg WASM encode/decode (`src/ffmpeg/`)
- kissfft audio analysis (`src/wasm/audioAnalysis.ts`)
- the WebGPU preview compositor (`src/webgpu/previewEngine.ts`)

## Ops

| `op` | Output | Use |
| --- | --- | --- |
| `luma_histogram_bt709` | 256×u32 + auto levels | Inspector exposure peek |
| `downsample_2d` | small RGBA | Library / scrubber posters (96×54) |
| `separable_blur` | RGBA | Optional UI soft masks |

Rec.709 luma uses encoded sRGB weights `0.2126 / 0.7152 / 0.0722` (Chromashift / WebGPU fundamentals). Downsample golden is bilinear; Canvas2D `drawImage` may differ slightly (mipmaps) — MAE &lt; 4/channel is the documented tolerance.

Workgroups: `@workgroup_size(8, 8)`.

## Backends

1. **WebGPU** — only if a `GPUDevice` was already acquired (`acquireGpuContext` / preview engine / preview worker). Chores call `adoptGpuDevice` / `peekGpuDevice` and **never** `requestDevice()`. After a failed WebGPU probe, GPU preview hard-fails (Canvas2D is not a GPU fallback) and chores stay on Worker/TS.
2. When live preview owns the device in the **OffscreenCanvas worker**, main-thread import posts an `ImageBitmap` on `chore-jobs` and gets back aggregates (256×u32 histogram + 96×54 RGBA). The main thread does not `getImageData` the full still.
3. **Worker** (`backend: 'wasm'`) — rasterize the bitmap off-thread, then the same TS golden math. No extra image-FFT WASM; audio kissfft stays source of truth for beats.
4. **Main-thread TS** — last resort / tiny images (&lt; 256²) / Vitest.

WebGL2 is deferred on purpose: do not dual-hot GL + WebGPU on the same clip pixels.

## Break-even (`prefer: 'auto'`)

| Kernel | GPU when |
| --- | --- |
| histogram | source ≥ **1 MP** and a device is adopted |
| downsample | source ≥ **1 MP** and dest area ≤ source/4 |
| blur | `pixels * radius` ≥ 2e6 |

Below 256², skip the Worker too (postMessage overhead). Kill switch: `?no_gpu_compute`.

## Diagnostics

- `gpuComputeAvailable()` → `{ available, reason }`
- Inspector **Levels** crumb + **Copy Debug** `## gpu-chores` section
- Last job: `getLastGpuChoreBreadcrumb()`
