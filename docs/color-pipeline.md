# Color pipeline

The default picture is Rec.709 / sRGB, limited range, end to end. That path does not run the transforms in this document: finishing stays the existing 8-bit chain (noise → primary → secondary → LUT → sharpen → grain), the canvas is `colorSpace: 'srgb'` with `toneMapping.mode: 'standard'`, and `VideoEncoder` is tagged `bt709` / `bt709` / `bt709` / `fullRange: false`.

Managed mode turns on when **Output color** is Display P3 or HDR10, or **Working space** is scene-linear Rec.2020. Untagged imports are assumed Rec.709. There is no per-clip ICC and no OpenColorIO.

## Working space

Scene-linear Rec.2020, D65. Diffuse white is `1.0`, which the PQ output transform maps to **100 nits** (`PQ_REFERENCE_WHITE_NITS`). Values above 1 are highlights.

Matrices live in `src/utils/colorManagement.ts` (row-major) and are packed into the WGSL uniform. They are the CSS Color 4 / BT.2020 D65 RGB→XYZ matrices and their products:

- Rec.709 linear → Rec.2020 linear: `REC709_TO_REC2020`
- Rec.2020 linear → Rec.709 linear: `REC2020_TO_REC709`
- Rec.2020 linear → Display P3 linear: `REC2020_TO_DISPLAY_P3`
- Display P3 linear → Rec.709 linear: `DISPLAY_P3_TO_REC709`

The sRGB / IEC 61966-2-1 piecewise curve matches `srgbToLinear` / `linearToSrgb` in `primaryColor.wgsl`. PQ is ST 2084 (0 nits → code 0, 100 nits → ~0.5081, 1000 nits → ~0.7518, 10000 nits → 1).

## Pass order

Managed frames only:

```
encoded Rec.709
  → input (linearize, matrix to Rec.2020)     rgba16float
  → noise → primary → secondary → LUT → sharpen
  → output transform
  → grain (display-referred codes)
  → present (swapchain)
```

Grain stays last so a later pass cannot soften it. On the Rec.709 default the output transform is not dispatched, so grain still sees the same encoded 8-bit image.

Primary skips its internal sRGB decode/encode when the sample is already linear (`PrimaryColorUniforms._pad4.x`). Secondary, LUT, sharpen, and denoise relax the 0–1 clamps only on the scene-linear shader variant. The default pipelines keep `const SCENE_LINEAR = false`.

The working texture is `rgba16float` (core, keeps alpha). `rg11b10ufloat-renderable` is still adopted when the adapter has it, and is not the working target. `shader-f16` is adopted when present and used for the color-transform matrix multiply; it is never required.

## Output

| Choice | File tags | Preview |
| --- | --- | --- |
| Rec.709 SDR | `bt709` / `bt709` / `bt709`, limited | sRGB canvas, standard tone map |
| Display P3 | `smpte432` / `iec61966-2-1` / `rgb`, full range | `colorSpace: 'display-p3'` when `configure` accepts it; otherwise the present pass converts P3 → sRGB and the control/export says so |
| HDR10 | `bt2020` / `pq` / `bt2020-ncl`, limited, HEVC Main10 (`hvc1.2.4.L123.B0`) or AV1 10-bit (`av01.0.08M.10`) | 8-bit swapchain cannot store values above 1, so preview is a 100-nit SDR downmap of the PQ image. The encoded frame is a readback of the PQ codes (`VideoFrame` from an RGBA buffer), not `VideoFrame(canvas)` |

HDR10 does not fall through to 8-bit H.264. If neither 10-bit candidate is accepted, the control is disabled and export throws rather than writing a Rec.709 file with PQ tags. Display P3 is the same: the probe and `configure()` use one config object.

Force FFmpeg and the MediaRecorder canvas path do not run this pipeline. The render plan sets `wideColor: 'ignored'` and the toolbar says the file is Rec.709 SDR.

## Later FFmpeg approximation

Not implemented. A CPU fallback can approximate the same matrices with `colorspace` / `zscale` (primaries and transfer only — window grades and the creative LUT stay WebGPU-only, as they do today):

- Rec.709 → Rec.2020 linear is a primaries conversion plus a linear transfer.
- Display P3 is sRGB transfer with SMPTE EG 432-1 primaries.
- HDR10 is Rec.2020 primaries, SMPTE ST 2084, non-constant luminance matrix, 100-nit reference white.

Do not tag a Rec.709 encode as PQ or Display P3 to stand in for that.
