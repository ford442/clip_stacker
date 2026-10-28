# Media engine WASM (timeline PCM mix)

C++ owns the export premix DSP: polyphase resampling, clip insert effects
(EQ, compressor), volume/pan automation curves, fades, lane buses (insert
chains, gate, de-esser, sidechain ducking, delay compensation), the master
bus, true-peak limiting, BS.1770 loudness metering and a streaming (chunked)
mix. WebGPU still owns pixels; this module never touches video frames. Live
preview stays on the Web Audio graph (`src/audio/playbackManager.ts`), but its
insert effects come from this module too (`insert_chain_*` over the decoded
buffer), and its bus stage runs the same bus graph in an AudioWorklet
(`media_engine_fx.wasm` — see `docs/web-audio-playback.md`).

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
- `public/wasm/media_engine_fx.wasm` — the bus DSP alone, built
  `-sSTANDALONE_WASM --no-entry` (no JS glue) for the preview's AudioWorklet

Gzipped `.wasm` must stay under **200 KB** (`scripts/wasm-size-check.sh` fails the build otherwise; it is ~36 KB, the fx build ~30 KB). If it passes ~80 KB, simplify before adding anything heavier (e.g. convolution reverb).

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

`tests/bus_fx_tests.cpp` covers the bus layer: the EBU Tech 3341 minimum
requirements (#1–5 integrated, #9 / #12 short-term / momentary, #15–19 true
peak) and Tech 3342 LRA cases #1–4, synthesised; the duck reaching its depth
within `attack` and recovering within `hold + release`; the limiter's true
peak on inter-sample-peak signals (and a sample-peak limiter failing the
same case); gate, de-esser and delay compensation; chunk / block invariance
with every effect; the standalone graph equal to the session bit for bit; an
inactive layout byte-identical to the legacy mix; two-pass normalization
landing within 0.5 LU; and silence after a tone staying out of subnormals.

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
- **Limiter** (`src/fx/limiter.cpp`): look-ahead brickwall, true peak. A
  `TruePeakDetector` oversamples 4× with the resampler's own polyphase sinc
  (phases ¼, ½, ¾; phase 0 is the sample) — ITU-R BS.1770-4 Annex 2 — and
  reports each frame's true peak 32 frames late. The gain for frame *j* is
  the box average, over the look-ahead *L* (≥ 32 frames), of an
  instant-attack / exponential-release envelope of the sliding minimum of the
  gain each frame needs — every frame in that average saw *j* coming. Needs
  are computed 0.05 dB under the ceiling: the gain's own movement lets the
  oversampled output overshoot by ~0.005 dB without that margin. A final
  sample clamp guarantees the sample peak. Below the ceiling it is
  bit-transparent, and the session hides its 32 + *L* frames of delay.
- **Gate, de-esser, ducker** (`src/dynamics.cpp`): the gate opens at its
  threshold, holds, and moves in dB with attack / release; the de-esser is a
  dynamic high shelf driven by a high-pass detector (its 0 dB coefficients
  are exactly the identity, so an idle de-esser is bit-transparent); the
  ducker ramps linearly in dB from another lane's peak, so it lands on its
  depth exactly `attack` after the key starts and recovers exactly `hold +
  release` after it stops.
- **Bus graph** (`src/fx/bus.cpp`): lanes in packed order, frame by frame —
  chain, delay compensation to the slowest lane chain, duck (keyed by a lane
  already processed this frame) — then the master chain, a static output
  gain, a final limiter stage and the meter. `bus_graph_update` retunes in
  place when the structure (stage kinds, ducks, look-aheads) is unchanged.
- **Loudness** (`src/fx/loudness.cpp`): BS.1770-4 K-weighting designed at any
  rate (matches the 48 kHz table exactly), 100 ms sub-blocks, momentary
  (400 ms) / short-term (3 s), integrated over 400 ms blocks at 75 % overlap
  with the −70 LUFS / −10 LU gates, EBU Tech 3342 LRA, true and sample peak.
- **Denormals**: every recursive path flushes |v| < 1e-30 (WASM has no FTZ).

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

### Buses

`mix_bus_session_create(rate, ch, states, effects, n, buses, bus_count,
master_first, master_count, output_gain_db, final_first, final_count, flags)`
adds lane buses to a session: `buses` is `MIX_BUS_STRIDE` ints per lane (a row
range of the effect blob), entries route with `MIX_ENTRY_FX_BUS` (out of range
= the direct input), and `MIX_BUS_FLAG_METER` turns on the output meter
(`mix_fx_session_meters`, `MIX_METER_*` layout). A layout that processes
nothing creates no graph at all, so the mix stays byte-identical.
`bus_graph_*` is the same graph without the mixer, fed lane PCM
(`bus_count + 1` interleaved blocks) — the AudioWorklet's API — and
`loudness_meter_*` is the meter alone.

Kill switch: `?no_media_engine` (disables the mix, inserts, buses and limiter alike); `?no_audio_fx` disables only the preview's bus worklet.
