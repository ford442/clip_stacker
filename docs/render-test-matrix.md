# Render Test Matrix

Manual test cases for the clip_stacker render pipeline.

| ID   | Priority | Scenario | Steps | Expected |
|------|----------|----------|-------|----------|
| R001 | P1 | Single clip render | Upload 1 MP4, Render | MP4 downloads, lossless or re-encode per plan |
| R002 | P0 | Two-clip lossless concat | Upload 2 MP4s (same resolution, no fades), Render | Fast lossless concat, no "undefined" errors |
| R003 | P0 | Two-clip with transition | Upload 2 MP4s, add dissolve transition, Render | filter_complex re-encode succeeds or shows real FFmpeg error |
| R004 | P1 | Fade on clip | Set videoFadeOut > 0 on one clip, Render | Re-encode path, meaningful error if fails |
| R005 | P2 | Audio-only clip | Upload WAV/MP3, Render | Audio mux path works |
| R006 | P2 | PiP overlay | Set layerIndex > 0 on second clip, Render | Compositing filter_complex |
| R007 | P2 | Text overlay | Add text overlay, Render | drawtext in filter_complex |
| R008 | P1 | FFmpeg load failure | Block CDN / clear cache, Render | Retry button, no "undefined" in status |

Run `./scripts/debug-render.sh` for automated smoke tests, then verify R002 and R003 manually via `npm run preview`.
