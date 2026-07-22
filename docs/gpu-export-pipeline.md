# GPU export pipeline (WebCodecs + WebGPU)

The primary export path is fully GPU-driven; FFmpeg WASM is scoped to audio
work and explicit fallback only.

```
┌─────────────┐    VideoFrame     ┌──────────────────┐    canvas frame   ┌─────────────┐
│ VideoDecoder│ ────────────────► │ WebGPU compositor │ ────────────────► │VideoEncoder │
│ (WebCodecs) │   (ring buffer)   │ (exportCompositor)│                   │ (hardware)  │
└─────────────┘                   └──────────────────┘                   └──────┬──────┘
                                                                                │ H.264/HEVC/AV1
                                                                                ▼
                                                                        ┌────────────────┐
                                                                        │ mp4-muxer      │
                                                                        │ (video track)  │
                                                                        └───────┬────────┘
┌─────────────┐    audio decode / final mux                            ┌────────▼────────┐
│ FFmpeg WASM │ ◄──────────────────────────────────────────────────────│ final MP4 output│
└─────────────┘                                                        └─────────────────┘
```

## Stages

1. **Decode** — `src/utils/webcodecs-decoder.ts`. Each clip is demuxed with
   mp4box and decoded with a hardware `VideoDecoder`. Frames flow through a
   small ring buffer (`FRAME_RING_BUFFER_CAPACITY`) so decode overlaps
   composite + encode. Seeking is exact: decode starts at the last sync sample
   at or before `trimStart` and pre-roll frames are dropped. If a clip cannot
   be demuxed or its codec cannot be decoded, the export loop transparently
   falls back to the legacy `HTMLVideoElement` + `requestVideoFrameCallback`
   capture for that clip.
2. **Composite** — `src/webgpu/exportCompositor.ts` (single-clip letterbox +
   fades + LUT) or `src/webgpu/timelinePreview.ts` (transitions, PiP layers,
   keyframes, text overlays) render with the same WGSL shaders as the live
   preview, so the export is WYSIWYG.
3. **Encode** — hardware `VideoEncoder` via `resolveEncoderCodec()`
   (`src/utils/webcodecs.ts`). `ExportSettings.videoCodec` selects
   `h264` (default) / `hevc` / `av1`; HEVC and AV1 are probed with
   `VideoEncoder.isConfigSupported` and silently fall back to hardware H.264.
   The H.264 level is chosen from the output resolution.
4. **Mux** — `mp4-muxer` writes the video track; `muxVideoWithAudio`
   (`src/ffmpeg/mux.ts`) adds source audio.

## Path selection

`hybridMergeClips` (`src/utils/hybrid-encoder.ts`) consults
`canUseGpuVideoEncoder` (`src/utils/renderEligibility.ts`). With WebGPU
available, transitions, PiP/multi-layer stacks, keyframe animation, still
images, color grades, and text overlays (solid and shader) all stay on the GPU
path via the timeline compositor.

## FFmpeg WASM scope

FFmpeg WASM is used only for:

- audio extraction / WAV generation,
- muxing source audio into the GPU-encoded video,
- the explicit "Force FFmpeg" override,
- full fallback when WebCodecs is unavailable (`feature-detector` reports
  `webcodecs: false`) or a GPU encode attempt fails.
