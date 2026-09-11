# Video stabilization WASM module

C++ → Emscripten module that measures camera shake with sparse optical flow and
returns per-frame correction matrices for the WebGPU preview, the GPU/canvas
export paths, and (optionally) FFmpeg's `vidstabtransform`.

## Dependencies

None. Corner detection, pyramidal Lucas-Kanade, the RANSAC fit and the bilinear
warp are all in `video_stabilize.cpp` (~700 lines), so there is nothing vendored
under `third_party/`.

## Build

Requires [Emscripten](https://emscripten.org/) (`emcc` on `PATH`):

```bash
npm run build:video-stabilize
```

Outputs (both committed):

- `public/wasm/video_stabilize.js`
- `public/wasm/video_stabilize.wasm` (~35 KB, ~16 KB gzipped)

## Algorithm

1. **Shi-Tomasi corners** on the previous frame — smallest eigenvalue of the
   windowed structure tensor, thresholded against the frame's best corner, then
   thinned so no two survivors sit within 10 px. Spatial spread matters more
   than raw corner strength when the points feed a single global motion fit.
2. **Pyramidal Lucas-Kanade** tracks each corner into the current frame. Three
   levels, a 9×9 window and 8 iterations per level; starting coarse is what
   lets it follow motion wider than the window.
3. **RANSAC similarity fit** over the surviving correspondences, then a
   closed-form least-squares refit on the consensus set. Deliberately a
   similarity (rotate + uniform scale + translate) rather than a full 6-DOF
   affine: shear and anisotropic scale are never real handheld camera motion,
   so leaving them free only lets tracking noise into the correction, where it
   shows up as a wobbling picture.
4. **Trajectory smoothing** — the per-frame motions accumulate into a camera
   path, a centred moving average smooths it, and the correction for frame *i*
   is how far the real path ran ahead of the smoothed one. A deliberate pan
   survives; shake does not.
5. **Auto-crop** — warping exposes empty edges, so the corrections zoom in by
   just enough to keep the worst-case shift off screen, capped at 1.25×.

## API

See `video_stabilize.h`. Usage is strictly two-phase, because the smoother is
*centred*: the correction for frame *i* depends on frames up to
*i + smoothRadius*, so nothing is knowable until every frame is in.

| Function | Purpose |
|----------|---------|
| `stab_create(w, h, smoothRadius)` | Allocate for `w`×`h` grayscale analysis frames |
| `stab_push_frame(h, gray)` | Push one frame in presentation order → its index |
| `stab_frame_count(h)` | Frames pushed so far |
| `stab_finalize(h)` | Smooth the trajectory and build corrections (idempotent) |
| `stab_get_matrix(h, i, out[6])` | Frame `i`'s correction; identity before finalize |
| `stab_get_zoom(h)` | Auto-crop baked into the matrices |
| `stab_get_max_correction(h)` | Peak correction, as a fraction of frame width |
| `stab_apply_warp(h, rgbaIn, rgbaOut, i)` | CPU reference warp at analysis resolution |
| `stab_destroy(h)` | Free |

### Matrix convention

`stab_get_matrix` writes `[a, b, tx, c, d, ty]` — an **inverse** warp in
**normalized UV**, centred on the frame:

```
uvSrc.x = a * (uvDst.x - 0.5) + b * (uvDst.y - 0.5) + 0.5 + tx
uvSrc.y = c * (uvDst.x - 0.5) + d * (uvDst.y - 0.5) + 0.5 + ty
```

Identity is `[1, 0, 0, 0, 1, 0]`. Frame aspect is already folded into `b`/`c`
and the auto-crop into `a`/`b`/`c`/`d`, so a shader can use the six floats as a
UV lookup with no further work, at any output resolution. The CPU paths invert
it (`stabMatrixToCanvasTransform`) because they push pixels the other way.

TypeScript bindings live in `src/wasm/videoStabilize.ts`.
