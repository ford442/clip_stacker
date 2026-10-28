# Web Audio timeline playback

Preview play/scrub uses a Web Audio graph instead of `<audio>` / unmuted
`<video>` elements so the playhead stays sample-accurate with the WebGPU
compositor.

```
Play / scrub
    │
    ▼
AudioPlaybackManager ── scheduleFrom() ──► AudioBufferSourceNode(s)
    │                         │   (buffer: decoded → remapped → insert-processed)
    │                         ├─ GainNode (volume + fades + legacy bed step)
    │                         ├─ StereoPannerNode
    │                         ▼
    │              [lane input GainNode ──► bus-graph AudioWorkletNode]   (only with bus FX / LUFS meter)
    │                         ▼
    │                    master GainNode ──► AnalyserNode ──► destination
    │
    └── getCurrentTime() ──► Preview rAF playhead / WebGPU frame
                             (minus the bus graph's look-ahead delay)
```

## Modules

| File | Role |
|------|------|
| `src/audio/clipAudioCache.ts` | Decode + cache `AudioBuffer` per clip (`decodeAudioData`) |
| `src/audio/schedule.ts` | Timeline placements, bed ducking, structure compare |
| `src/audio/processedAudioCache.ts` | Clip insert effects (EQ / compressor) baked into a copy of the buffer by the media-engine C++ |
| `src/audio/playbackManager.ts` | Context lifecycle, play/pause/seek, analyser meter |
| `src/audio/busRouting.ts` | Lane inputs → bus-graph AudioWorklet (lane / master FX, ducks, loudness meter) |
| `src/audio/fxGraph.ts` | Tracks + master bus → the engine's packed bus layout (shared with export) |
| `src/wasm/audioFx.ts`, `public/worklets/audio-fx-processor.js` | Compile `media_engine_fx.wasm`, register the processor, drive the node |
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
  `BED_DUCK_LINEAR` (≈ −9 dB) — the legacy step, kept for lanes that set no
  `Track.duck`. A lane with a sidechain duck instead follows the key lane's
  envelope in the bus graph (below); `'off'` turns ducking off.
- **Lane buses** (`Track.audioFx`, `Track.duck`, `Project.masterBus.fx`) run
  live in the bus-graph AudioWorklet: each lane's sources sum into one input
  of the node, which runs the media engine's `BusGraph` (lane chains, delay
  compensation, sidechain ducks, master chain) — the same C++ as export, so
  the two match bit for bit. A sidechain duck depends on another lane at
  playback time and the master chain sees the sum, which is why this cannot be
  baked into clip buffers the way inserts are. Parameter edits retune the
  running graph (`bus_graph_update`); a change of lanes or their order builds
  a new node and reschedules. The graph's look-ahead (limiters) delays the
  audio by a few ms; `getCurrentTime()` subtracts it so the picture follows.
  Play and seek clear its filter / envelope state. Without bus FX and with the
  LUFS meter closed, the node is not in the graph at all.
  - `?no_audio_fx`, no AudioWorklet, or a load / processor failure: the
    preview plays the buses dry and the Master row shows "FX not previewed";
    export still applies them. No `DynamicsCompressorNode` stand-in.
  - The export loudness target is not previewed (it needs the whole
    programme); the LUFS meter on the Master row shows the preview's
    momentary / short-term / integrated loudness, range and true peak from the
    same BS.1770 meter the export uses.
- **Insert effects** (`Clip.audioEffects`: up to 4 EQ bands, one compressor)
  are not Web Audio nodes. `ProcessedAudioCache` runs the media engine's C++
  `InsertChain` (the one the export mix runs per entry) over a copy of the
  clip's buffer, from its trim start, and that copy is scheduled like any
  other buffer — so preview and export hear the same samples and the meter
  reflects the processed level. An edit changes the cache key and the
  schedule structure, so a playing preview reschedules with the rebuilt buffer;
  the Inspector debounces drags (`AUDIO_EFFECTS_COMMIT_DEBOUNCE_MS`). Clips
  with no enabled block keep the plain decoded buffer and pay no WASM pass.
  Do not add `BiquadFilterNode` / `DynamicsCompressorNode` "for live
  tweaking": that forks the math the media engine exists to own.
  - With `?no_media_engine` (or a failed load) inserts are bypassed here *and*
    in export, never approximated.
  - Filters are designed at the clip's playback rate × the context rate, so a
    sped-up clip gets the export's output-domain EQ. The remaining difference
    is the design rate itself (context rate vs 48 kHz export), audible only
    near Nyquist.
  - The export settings' **master limiter** and the loudness target are
    export-only; the preview plays the un-normalized mix. A limiter placed in
    a lane or master chain is previewed like any other bus effect.
- **Fallback** when `AudioContext` cannot be created: Preview plays muted on a
  wall-clock timer; hidden `<video>` elements stay `muted` for frame capture.

## Non-goals

Export audio still uses WebCodecs AAC or FFmpeg mux (`docs/gpu-export-pipeline.md`).
This graph is preview-only.
