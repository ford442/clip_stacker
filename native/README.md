# Native WASM modules

Shared Emscripten toolchain for audio analysis, stabilization, and the media
engine (timeline mix, insert effects, WSOLA time stretch), plus the opt-in
whisper module. Flags live in `toolchain.cmake`; the shell driver is
`scripts/emscripten-flags.sh`.

```bash
npm run build:wasm            # release → public/wasm (committed)
npm run build:wasm:debug      # -O0 -g, ASSERTIONS → native/build-debug/wasm
npm run build:whisper         # opt-in, -DCLIP_STACKER_WHISPER=ON (not committed)
```

Artifacts are written to `public/wasm/` and committed. Gzip size > 200 KB fails
the build. CI rebuilds every module and fails on `git diff -- public/wasm`.

The CMake tree lives in `$WASM_BUILD_DIR` (default `native/build/`, or
`native/build-debug/` for debug builds, whose output never touches
`public/wasm`). The dev and preview servers serve `native/build-debug/wasm` at
`/wasm-debug/`; open the app with `?wasm_debug` to load it (main-thread loaders
pick it up directly; workers get it through the base URL main passes them).

## Emscripten version

`native/emsdk-version` pins the SDK the committed artifacts come from; CI's
`wasm` job installs exactly that version. `scripts/emscripten-flags.sh` refuses
SDKs older than 3.1.64, warns above the tested major, and notes when a
different version will produce bytes the drift check rejects. To move the pin:
install the new SDK, `npm run build:wasm`, commit `native/emsdk-version` and
`public/wasm/` together.

The glue is ES6 (`EXPORT_ES6`) and resolves its `.wasm` with
`new URL(..., import.meta.url)` by default — emsdk >= 4 no longer accepts
`USE_ES6_IMPORT_META=0`. The loaders always pass `locateFile`, so that default
is never used. `INCOMING_MODULE_JS_API` is pinned to `locateFile` and
`instantiateWasm` (Vitest compiles `file://` bytes itself through the latter).

## Shared conventions (`common/include/`)

- `cs_status.h` — every `int`-returning entry point returns a `cs_status`
  (`CS_OK = 0`, `CS_EINVAL`, `CS_ENOMEM`, `CS_ESTATE`, `CS_ERANGE`,
  `CS_EINTERNAL`), mirrored by `CS_STATUS` in `src/wasm/emscriptenLoader.ts`.
  `cs_span_ok(offset, count, size)` is the bounds check for any buffer JS
  describes with an offset and a length (e.g. `pcm_floats` in the mixer).
- `cs_alloc.h` — the modules build with `-fno-exceptions`, so a failed
  `std::vector` allocation aborts and kills the module for the session.
  Caller-sized buffers use `cs::Buffer` (nothrow new) or `cs::try_reserve` /
  `cs::can_allocate` and return `CS_ENOMEM` instead.
- `cs_math.h` — `cs::kPi`; the code builds as strict C++17 (no GNU
  extensions), where `M_PI` is not guaranteed.

WASM targets compile with `-Wall -Wextra`; host targets add `-Werror`.

## Host tests (no Emscripten)

Every DSP translation unit that ships in `public/wasm/` is also built with the
native compiler as a static `<module>_dsp` library and tested through ctest
(ASan + UBSan on by default), so numeric regressions fail without going
through the JS glue:

```bash
npm run test:native                      # configure + build + ctest in native/build-host
HOST_SANITIZE=0 npm run test:native      # plain Release build
native/build-host/media_engine/tests/media_engine_tests --list
native/build-host/video_stabilize/video_stabilize_tests translated   # name filter
```

| Module | ctest | Covers |
| --- | --- | --- |
| `audio_analysis` | `audio_analysis_tests` | a sine lights only its band; silence stays at zero energy / zero beat; `getHopSize` = FFT/2 (and FFT size rounding); a click after silence fires one onset, `resetAnalyzer` clears it. kissfft builds with the same `-ffp-contract=off` host flags. |
| `video_stabilize` | `video_stabilize_tests` | static frames finalize to identity; a translated frame gives a `tx`/`ty` that follows the content shift (opposite the camera move) in normalized UV; matrices before finalize are identity; invalid `stab_create` is null. `stab_math.h` (similarity fit, smoother, motion → UV corrections) is tested directly on synthetic motion. |
| `media_engine` | `media_engine_host` | resampler THD+N goldens, chunk bit-equality, curve / pan parity, slice bounds against `pcm_floats`. |
| `media_engine` | `bus_fx_tests` | lane buses and loudness: EBU Tech 3341 integrated / momentary / short-term / true-peak and Tech 3342 LRA signals (synthesised); duck timing; true-peak limiting of inter-sample peaks; gate, de-esser, delay compensation; chunk / block invariance with every effect; standalone graph == session; inactive layouts byte-identical to the legacy mix; two-pass normalization; no subnormals in silence after a tone. |
| `media_engine` | `time_stretch_tests` | WSOLA: rate 1 is bit-exact (mono, stereo, offsets a hair off whole frames); 2x and 0.5x keep pitch (zero-crossing) and level; the similarity search keeps a slowed tone's envelope flat where plain OLA (tolerance 0) dips; positions past 2^24 frames stay sub-sample; output past the last offset and reads outside the input are silence; bad args are `CS_EINVAL`. |

Tests use the tiny runner in `host_test/host_test.h` (no third-party test
framework). Configuring `native/` with plain `cmake` requires
`-DCLIP_STACKER_HOST_TESTS=ON` (`host.cmake` holds the host flags); anything
else must go through `emcmake`. CI runs the same script in the `native-host`
job. New DSP (insert effects, a threaded mix) should land its goldens here
before the WASM glue changes.

## clangd

The WASM configure passes `CMAKE_EXPORT_COMPILE_COMMANDS=ON` and links
`$WASM_BUILD_DIR/compile_commands.json` to `native/compile_commands.json`
(gitignored — it holds machine-absolute paths). `native/.clangd` points clangd
at it. Because the database invokes `em++`, start clangd with
`--query-driver` so it picks up Emscripten's sysroot and the wasm32 target:

```jsonc
// VS Code settings.json
"clangd.arguments": ["--query-driver=**/em++"]
```

Either configure leaves `native/compile_commands.json` in place:
`npm run build:wasm` always points it at the WASM tree, and `npm run
test:native` points it at the host tree unless it already resolves to a WASM
database. Prefer the WASM one when you have emsdk (it is what actually ships,
with em++'s sysroot); the host one is the no-emsdk fallback.
