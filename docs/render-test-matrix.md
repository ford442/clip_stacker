# Render Test Matrix

Manual test cases for the clip_stacker render pipeline.

| ID   | Priority | Scenario | Steps | Expected |
|------|----------|----------|-------|----------|
| R001 | P1 | Single clip render | Upload 1 MP4, Render | MP4 downloads, lossless or re-encode per plan |
| R002 | P0 | Two-clip lossless concat | Upload 2 MP4s (same resolution, no fades), Render | Fast lossless concat, no "undefined" errors |
| R003 | P0 | Two-clip with transition | Upload 2 MP4s, add dissolve transition, Render | filter_complex re-encode succeeds or shows real FFmpeg error |
| R004 | P1 | Fade on clip | Set videoFadeOut > 0 on one clip, Render | Re-encode path, meaningful error if fails |
| R005 | P2 | Audio-only clip | Upload WAV/MP3, Render | Audio mux path works |
| R006 | P2 | PiP overlay | Set layerIndex > 0 on second clip, Render | Compositing filter_complex **or** WebGPU timeline compositor when WebCodecs/WebGPU available |
| R007 | P2 | Text overlay | Add text overlay, Render | drawtext in filter_complex **or** decoder + overlay post-pass on GPU path |
| R008 | P1 | FFmpeg load failure | Block CDN / clear cache, Render | Retry button, no "undefined" in status |
| R009 | P2 | Finishing passes (LUT) | Enable 3D LUT in Export → Finishing, preview + GPU export | Graded preview/export on WebGPU path; Canvas2D/FFmpeg ungraded |
| R010 | P0 | GPU WebCodecs export | Upload 2+ clips with fades/rescaling (no Force FFmpeg), Render | Path `webcodecs` or `webcodecs-av`; VideoDecoder → WebGPU → VideoEncoder; FFmpeg only for audio mux if needed |
| R011 | P1 | Codec preference | Export tab → Video codec HEVC/AV1, Render on supporting browser | Encodes preferred codec or silently falls back to H.264 |

Run `./scripts/debug-render.sh` for automated smoke tests, then verify R002, R003, and R010 manually via `npm run preview`.
