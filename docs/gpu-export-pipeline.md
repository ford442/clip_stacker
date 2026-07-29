# GPU export pipeline (WebCodecs + WebGPU)

The primary export path is fully GPU-driven; FFmpeg WASM is scoped to audio
fallback and explicit override only.

```
┌─────────────┐    VideoFrame     ┌──────────────────┐    canvas frame   ┌─────────────┐
│ VideoDecoder│ ────────────────► │ WebGPU compositor │ ────────────────► │VideoEncoder │
│ (WebCodecs) │   (ring buffer)   │ (exportCompositor)│                   │ (hardware)  │
└─────────────┘                   └──────────────────┘                   └──────┬──────┘
                                                                                │ H.264/HEVC/AV1
                                                                                ▼
┌─────────────┐   PCM mix (OfflineAudioContext)   ┌─────────────┐        ┌────────────────┐
│ Clip audio  │ ────────────────────────────────► │AudioEncoder │ ─────► │ mp4-muxer      │
│ (schedule)  │                                   │ (AAC-LC)    │        │ (video + audio)│
└─────────────┘                                   └─────────────┘        └───────┬────────┘
                                                                                 ▼
                                                                         ┌────────────────┐
┌─────────────┐   audio mux fallback only                                  │ final MP4      │
│ FFmpeg WASM │ ◄────────────────────────────────────────────────────────│ output         │
└─────────────┘                                                          └────────────────┘
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
3. **Encode (video)** — hardware `VideoEncoder` via `resolveEncoderCodec()`
   (`src/utils/webcodecs.ts`). `ExportSettings.videoCodec` selects
   `h264` (default) / `hevc` / `av1`; HEVC and AV1 are probed with
   `VideoEncoder.isConfigSupported` and silently fall back to hardware H.264.
   The H.264 level is chosen from the output resolution.
4. **Mix + encode (audio, happy path)** — `buildAudioSchedule`
   (`src/audio/schedule.ts`) places trimmed clips with volume and fades
   (including dissolve overlaps and PiP overlays). `OfflineAudioContext`
   renders the mix; `AudioEncoder` produces AAC-LC chunks
   (`src/utils/webcodecs-audio.ts`).
5. **Mux** — a single `mp4-muxer` session writes both video and audio tracks
   when the WebCodecs A/V path is selected (`webcodecs-av`). Otherwise
   `mp4-muxer` writes video-only and `muxVideoWithAudio` (`src/ffmpeg/mux.ts`)
   adds source audio via FFmpeg.

## Path selection

`hybridMergeClips` (`src/utils/hybrid-encoder.ts`) consults
`canUseGpuVideoEncoder` (`src/utils/renderEligibility.ts`). With WebGPU
available, transitions, PiP/multi-layer stacks, keyframe animation, still
images, color grades, and text overlays (solid and shader) all stay on the GPU
path via the timeline compositor.

| Path | When | FFmpeg loaded? |
|------|------|----------------|
| `webcodecs-av` | GPU video + `AudioEncoder` AAC + schedule mix OK | **No** |
| `webcodecs` | GPU video encode, audio mux needs FFmpeg | Yes (mux only) |
| `ffmpeg` | Fallback / force / lossless concat | Yes |
| `canvas` | Audio-reactive compositing | Yes (mux) |

Audio mix eligibility is checked with `assessWebCodecsAudioMix` (timeline
length cap, `OfflineAudioContext` availability). Unsupported cases surface a
status message and fall back to `webcodecs` + FFmpeg mux.

## FFmpeg WASM scope

FFmpeg WASM is used only for:

- audio extraction / WAV generation,
- muxing source audio when WebCodecs AAC is unavailable (`webcodecs` path),
- the explicit "Force FFmpeg" override,
- full fallback when WebCodecs is unavailable (`feature-detector` reports
  `webcodecs: false`) or a GPU encode attempt fails.

## Audio tolerance vs FFmpeg mux

The WebCodecs path uses the **preview schedule** (`buildAudioSchedule`) for
dissolve overlaps and PiP, which is closer to live playback than the legacy
FFmpeg GPU mux (sequential per-clip concat). Volume and fades follow the same
clip fields (`volume`, `audioFadeIn`, `audioFadeOut`). Spot-check: export the
same project on `webcodecs-av` and `webcodecs` paths and compare waveforms in
an external editor; expect sub-frame differences from AAC quantization.
