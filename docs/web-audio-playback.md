# Web Audio timeline playback

Preview play/scrub uses a Web Audio graph instead of `<audio>` / unmuted
`<video>` elements so the playhead stays sample-accurate with the WebGPU
compositor.

```
Play / scrub
    │
    ▼
AudioPlaybackManager ── scheduleFrom() ──► AudioBufferSourceNode(s)
    │                         │
    │                         ├─ GainNode (volume + fades + bed duck)
    │                         ▼
    │                    master GainNode ──► AnalyserNode ──► destination
    │
    └── getCurrentTime() ──► Preview rAF playhead / WebGPU frame
```

## Modules

| File | Role |
|------|------|
| `src/audio/clipAudioCache.ts` | Decode + cache `AudioBuffer` per clip (`decodeAudioData`) |
| `src/audio/schedule.ts` | Timeline placements, bed ducking, structure compare |
| `src/audio/playbackManager.ts` | Context lifecycle, play/pause/seek, analyser meter |
| `src/hooks/useTimelineAudioPlayback.ts` | Sync schedule + dispose on unmount |
| `src/hooks/usePlaybackAnalyserLevels.ts` | Poll analyser for UI meter / reactive hooks |

## Behavior

- **Play** resumes `AudioContext` from a user gesture, schedules every remaining
  clip at `ctx.currentTime + timeline offset`, and drives the visual playhead
  from `getCurrentTime()`.
- **Scrub while playing** coalesces seeks to one reschedule per animation frame
  (≈ one video frame @ 60 Hz UI / 30 fps timeline step on the scrubber).
- **Volume edits** while playing update active `GainNode`s in place when the
  schedule structure is unchanged (no audible restart).
- **Audio-bed tracks** (`isBed`) that overlap dialogue/base clips are ducked by
  `BED_DUCK_LINEAR` (≈ −9 dB).
- **Fallback** when `AudioContext` cannot be created: Preview plays muted on a
  wall-clock timer; hidden `<video>` elements stay `muted` for frame capture.

## Non-goals

Export audio still uses WebCodecs AAC or FFmpeg mux (`docs/gpu-export-pipeline.md`).
This graph is preview-only.
