# Media engine WASM (timeline PCM mix)

C++ owns the export premix DSP: polyphase resampling, clip insert effects
(EQ, compressor), volume/pan automation curves, fades, a bus limiter, and a
streaming (chunked) mix. WebGPU still owns pixels; this module never touches
video frames. Live preview stays on the Web Audio graph
(`src/audio/playbackManager.ts`), but its insert effects come from this module
too (`insert_chain_*` over the decoded buffer — see
`docs/web-audio-playback.md`).

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

Gzipped `.wasm` must stay under **200 KB** (`scripts/wasm-size-check.sh` fails the build otherwise; it is ~21 KB). If it passes ~80 KB, simplify before adding anything heavier (e.g. convolution reverb).

Host tests — same sources, native compiler, ctest, no Emscripten:

```bash
npm run test:native
```

`tests/media_engine_tests.cpp` holds the THD+N goldens (44.1 → 48 kHz sine),
alias rejection, chunked-vs-whole bit equality, curve and pan-law checks, a
pinned byte hash of a libm-free mix (a schedule without effect blocks must
keep producing it), and the effect goldens: biquad magnitude vs the cookbook
within 0.1 dB, compressor reduction on a −6 dBFS sine, the limiter's ceiling
and transparency, fx chunked-vs-whole bit equality, and preview/export parity.

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

- **Insert chain** (`src/eq.cpp`, `src/dynamics.cpp`, `include/effects.h`), per
  clip, after resampling and before the volume curve, so automation rides the
  processed signal: resample → EQ → compressor → gain/fades → pan → bus.
  - **EQ**: up to 4 RBJ Audio EQ Cookbook biquads (peaking, low / high shelf,
    high-pass; Q form), transposed direct form II with f64 state and a
    denormal flush (WASM has no FTZ).
  - **Compressor**: one per clip, feed-forward, quadratic soft knee, smooth
    branching attack/release on the gain in dB (Giannoulis–Massberg–Reiss),
    stereo linked on the louder channel, make-up gain.
  - The chain hears every frame of its entry, including silent ones and the
    tail past the clip's end, so its state never depends on gain or chunking.
- **Bus limiter**: one look-ahead brickwall limiter on the mix output (not per
  clip), ceiling −1 dBFS by default. The gain for frame *j* is the box average,
  over the look-ahead *L*, of an instant-attack / exponential-release envelope
  of the sliding minimum of the gain each frame needs — every frame in that
  average saw *j* coming, so the gain is already low enough when *j* plays.
  A final clamp turns "within a float ulp" into a guarantee. Below the ceiling
  it is bit-transparent, and the session hides its *L*-frame delay.

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

### Effects

Effects add rows, not a plugin ABI:

- **effect blocks** (`MIX_FX_STRIDE` f64): kind, enabled, freq, gain dB, Q,
  threshold dB, ratio, attack, release, knee dB. Unused fields are ignored;
  the limiter reads threshold as its ceiling and attack as look-ahead.
- **fx entries** (`MIX_ENTRY_FX_STRIDE` f64, flagged by `MIX_FLAG_EFFECTS`):
  the twelve legacy fields plus the entry's chain range and a stable
  filter-state slot (its schedule index).

Filters carry state, so an fx mix is stateful: `mix_fx_session_create`
copies the effect blob (and picks the bus limiter out of it),
`mix_fx_session_range` must be called with contiguous ranges from frame 0
(-3 otherwise), and `mix_fx_session_latency` tells the caller how far ahead
of the output the bus reads, so it can upload slices for that window.
`mix_timeline_audio_range` refuses `MIX_FLAG_EFFECTS` (-1).

An entry with no enabled block takes the exact legacy inner loop, so a
session without effect blocks or limiter is byte-identical to
`mix_timeline_audio_range` — and the TS stream does not even open a session
then.

`insert_chain_create` / `insert_chain_process` / `insert_chain_destroy` run a
clip chain over planar PCM in blocks (state carries between calls): the
preview's processed buffers.

TypeScript: `src/wasm/mediaEngine.ts` — `openTimelineMixStream` (chunked,
lazily acquires and releases clip PCM), `mixTimelineAudio` (whole buffer).
Export: `src/utils/webcodecs-audio.ts` streams chunks straight into
`AudioEncoder` (`encodeScheduleAudioStreaming`), so a 2-hour timeline never
needs a 45-minute `OfflineAudioContext`. Load failure disables the path;
export falls back to `OfflineAudioContext` (≤ 45 min) or FFmpeg audio mux.
That fallback mixes dry: it never builds Web Audio filters for the inserts.

Kill switch: `?no_media_engine` (disables the mix, inserts and limiter alike).
