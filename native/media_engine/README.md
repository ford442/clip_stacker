# Media engine WASM (timeline PCM mix)

C++ owns the export premix DSP: polyphase resampling, volume/pan automation
curves, fades, and a streaming (chunked) mix. WebGPU still owns pixels; this
module never touches video frames. Live preview stays on the Web Audio graph
(`src/audio/playbackManager.ts`).

## Build

Requires Emscripten (`emcc` / `emcmake` on `PATH`), same SDK as CI (3.1.64):

```bash
npm run build:media-engine
# or all four modules:
npm run build:wasm
# debug (-O0 -g, DWARF, ASSERTIONS):
WASM_DEBUG=1 npm run build:wasm
```

Outputs:

- `public/wasm/media_engine.js`
- `public/wasm/media_engine.wasm`

Gzipped `.wasm` must stay under **200 KB** (`scripts/wasm-size-check.sh` fails the build otherwise; it is ~13 KB).

Host tests — same sources, native compiler, ctest, no Emscripten:

```bash
npm run test:native
```

`tests/media_engine_tests.cpp` holds the THD+N goldens (44.1 → 48 kHz sine),
alias rejection, chunked-vs-whole bit equality, curve and pan-law checks.

## DSP

- **Resampler** (`src/resampler.cpp`): 64-tap Kaiser-windowed sinc (β = 10),
  512 polyphase rows with linear interpolation between rows, cutoff scaled by
  `1 / step` when a playback rate decimates. Inner product via GCC/Clang vector
  extensions → `f32x4` SIMD128 in WASM, SSE/NEON on the host test build.
  Same-rate clips (`step == 1`) are an exact integer-frame copy.
  Linear interpolation stays as a debug / fallback path (`MIX_FLAG_LINEAR_RESAMPLE`,
  `?media_engine_resampler=linear`).

  | 44.1 → 48 kHz, 0.5 FS sine | 1 kHz | 5 kHz | 10 kHz |
  |---|---|---|---|
  | THD+N polyphase | −114 dB | −116 dB | −112 dB |
  | THD+N linear (phase 1) | −62 dB | −34 dB | −20 dB |

- **Automation**: volume and pan keyframes are evaluated per sample with the
  same semantics as `sampleKeyframes` / `applyEasing` (`src/utils/keyframes.ts`):
  linear, bezier, bell curves. Volume keyframes are absolute gain × fades,
  clamped to 0…2 (`applyGainEnvelope`); pan follows the `StereoPannerNode`
  equal-power law, including −3 dB per side for a mono source at centre.

## API

`mix_timeline_audio_range(out, out_frames, start_frame, rate, channels, pcm, slices, slice_count, entries, entry_count, keyframes, keyframe_count, flags)`
— mixes output frames `[start_frame, start_frame + out_frames)`. Every frame is
a pure function of its absolute index, so chunking never changes the PCM.
Layouts are in `include/audio_mix.h`:

- **slices** (`MIX_SLICE_STRIDE` int32): a planar window of one clip's PCM
  (`first_frame`, frame count, clip length). Callers upload only what a chunk
  reads plus `MIX_SOURCE_MARGIN_FRAMES` either side.
- **entries** (`MIX_ENTRY_STRIDE` f64): placement, gain, fades, rate, and the
  keyframe ranges of the volume / pan curves.
- **keyframes** (`MIX_KEY_STRIDE` f64): time, value, easing code, bezier points.

`mix_timeline_audio` is the same call from frame 0.

TypeScript: `src/wasm/mediaEngine.ts` — `openTimelineMixStream` (chunked,
lazily acquires and releases clip PCM), `mixTimelineAudio` (whole buffer).
Export: `src/utils/webcodecs-audio.ts` streams chunks straight into
`AudioEncoder` (`encodeScheduleAudioStreaming`), so a 2-hour timeline never
needs a 45-minute `OfflineAudioContext`. Load failure disables the path;
export falls back to `OfflineAudioContext` (≤ 45 min) or FFmpeg audio mux.

Kill switch: `?no_media_engine`.
