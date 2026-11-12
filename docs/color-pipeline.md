# Color pipeline

The default picture is Rec.709 / sRGB, limited range, end to end. That path does not run the transforms in this document: finishing stays the existing 8-bit chain (noise → primary → curves → secondary → LUT → sharpen → chromatic aberration → bloom → grain), the canvas is `colorSpace: 'srgb'` with `toneMapping.mode: 'standard'`, and `VideoEncoder` is tagged `bt709` / `bt709` / `bt709` / `fullRange: false`.

Managed mode turns on when **Output color** is Display P3 or HDR10, or **Working space** is scene-linear Rec.2020. Untagged imports are assumed Rec.709. There is no per-clip ICC and no OpenColorIO.

## Sources

Decoded frames carry the file's tags (`VideoFrame.colorSpace`, from the `VideoDecoderConfig` the demuxer builds), and `importExternalTexture` converts them to the import colour space: Display P3 in managed mode (`importColorSpaceFor`), so P3 footage is not clipped to sRGB before the input transform; sRGB otherwise, byte-identical to before. A mistagged or untagged file can be reinterpreted per clip (`Clip.colorSpaceOverride`: Rec.709, sRGB, Display P3, Rec.2020 PQ, Rec.2020 HLG). The override replaces the tags in the decoder config, which takes precedence over in-band VUI, so the preview worker and the GPU export both decode with it. The Inspector shows the result ("Source: Rec.2020 PQ (from file)", or "… (override; file: …)"). WebM-alpha tracks and the `<video>` fallback keep the file's tags.

## Working space

Scene-linear Rec.2020, D65. Diffuse white is `1.0`, which the PQ output transform maps to **100 nits** (`PQ_REFERENCE_WHITE_NITS`). Values above 1 are highlights.

Matrices live in `src/finishing/colorManagement.ts` (row-major) and are packed into the WGSL uniform. They are the CSS Color 4 / BT.2020 D65 RGB→XYZ matrices and their products:

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
  → noise → primary → curves → secondary → LUT → sharpen → chromatic aberration → bloom
  → output transform
  → grain (display-referred codes)
  → present (swapchain)
```

Curves & levels are display-referred tools, so the scene-linear variant grades in an extended sRGB encoding and decodes back (values above 1 continue with slope 1). Chromatic aberration is a lens effect, so it runs in the working space before the output transform; it only resamples, so it has no clamp to relax. Bloom also runs there and adds light (the 8-bit chain screens it instead, so highlights roll off). Grain stays last so a later pass cannot soften it. On the Rec.709 default the output transform is not dispatched, so grain still sees the same encoded 8-bit image.

Primary skips its internal sRGB decode/encode when the sample is already linear (`PrimaryColorUniforms._pad4.x`). Secondary, LUT, sharpen, and denoise relax the 0–1 clamps only on the scene-linear shader variant. The default pipelines keep `const SCENE_LINEAR = false`.

The working texture is `rgba16float` (core, keeps alpha). `rg11b10ufloat-renderable` is not requested (it is not a canvas format and was never the working target). `shader-f16` is adopted when present and used for the color-transform matrix multiply; it is never required.

The compositor's canvas is chosen by `planCanvasSurface`:

| Output | Surface | Canvas |
| --- | --- | --- |
| HDR10 | export / harness (`offscreen`) | `rgba16float`: layers composite in float before the PQ output transform |
| HDR10 | preview, HDR display (`(dynamic-range: high)`) | `rgba16float`, `toneMapping: 'extended'`, Display P3: highlights above SDR white are shown (`pq-to-extended`) |
| HDR10 | preview, SDR display | preferred 8-bit format, 100-nit downmap (`pq-to-sdr`) |
| Display P3 | any | preferred format, `colorSpace: 'display-p3'` |
| Rec.709 | any | preferred format, sRGB |

If `configure()` rejects the request, the canvas falls back to the preferred format in sRGB / standard and the presentation says so. A format change rebuilds the device resources through the device-recovery path.

## Output

| Choice | File tags | Preview |
| --- | --- | --- |
| Rec.709 SDR | `bt709` / `bt709` / `bt709`, limited | sRGB canvas, standard tone map |
| Display P3 | `smpte432` / `iec61966-2-1` / `rgb`, full range | `colorSpace: 'display-p3'` when `configure` accepts it; otherwise the present pass converts P3 → sRGB and the control/export says so |
| HDR10 | `bt2020` / `pq` / `bt2020-ncl`, limited, HEVC Main10 (`hvc1.2.4.L123.B0`) or AV1 10-bit (`av01.0.08M.10`) | Extended-range float canvas on an HDR display; a 100-nit SDR downmap on an SDR one. The encoded frame is the PQ texture packed to I420P10 on the GPU (below), not `VideoFrame(canvas)` |

### HDR10 frames

`YuvPackPass` (`src/webgpu/shaders/yuvPack.wgsl`, CPU reference `src/finishing/yuvPack.ts`) converts the PQ-encoded R'G'B' texture to Y'CbCr with the BT.2020 non-constant-luminance matrix (Kr 0.2627, Kb 0.0593), quantizes to 10-bit limited range (Y 64–940, Cb/Cr 64–960) and writes planar I420P10 into a storage buffer. Chroma is sited at location 0 (left, between rows): a [1 2 1]/4 filter horizontally and the mean of the two rows vertically. `Hdr10FrameReader` copies the buffer through a three-slot `ReadbackRing` (pipelined `mapAsync`, nothing allocated per frame) into `new VideoFrame(planes, { format: 'I420P10', colorSpace: HDR10_COLOR_SPACE })`. A 1280x720 ramp keeps ~640 distinct Y codes; the old RGBA8 readback capped it at ~250. The pack has an 8-bit BT.709 mode (`i420-bt709`) for an SDR I420 path; the SDR export does not use it yet.

### HDR10 graphics

Titles and burned-in captions are drawn on the 2D text canvas (sRGB, premultiplied) and composited by `GraphicsOverlayPass` onto the scene-linear working texture before the output transform: decoded to linear, matrixed Rec.709 → Rec.2020, and scaled so text white lands at the **graphics white** (`ColorManagementSettings.graphicsWhiteNits`, default 203 nits per ITU-R BT.2408, 80–1000; gain = nits / 100). `src/finishing/hdrGraphics.ts` is the CPU reference. This replaced the refusal of HDR10 with titles or captions.

### Never a mislabelled file

HDR10 does not fall through to 8-bit H.264. If neither 10-bit candidate is accepted, the control is disabled and export throws rather than writing a Rec.709 file with PQ tags. Display P3 is the same: the probe and `configure()` use one config object.

Force FFmpeg and the MediaRecorder canvas path do not run this pipeline. The render plan sets `wideColor: 'ignored'` and the toolbar says the file is Rec.709 SDR. Those are the only ways a P3 / HDR10 project becomes a Rec.709 file: the router never *falls* to FFmpeg for a wide output (`wideOutputFfmpegRefusal` — no WebGPU or a RIFE clip refuses, a stream copy becomes a re-encode, and a failed H.264 probe does not demote it), and a GPU encode failure is re-thrown rather than retried on FFmpeg.

## Later FFmpeg approximation

Not implemented. A CPU fallback can approximate the same matrices with `colorspace` / `zscale` (primaries and transfer only — window grades and the creative LUT stay WebGPU-only, as they do today):

- Rec.709 → Rec.2020 linear is a primaries conversion plus a linear transfer.
- Display P3 is sRGB transfer with SMPTE EG 432-1 primaries.
- HDR10 is Rec.2020 primaries, SMPTE ST 2084, non-constant luminance matrix, 100-nit reference white.

Do not tag a Rec.709 encode as PQ or Display P3 to stand in for that.
