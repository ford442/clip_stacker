# Native WASM modules

Shared Emscripten toolchain for analysis, time-stretch, stabilization, and
timeline audio mix. Flags live in `toolchain.cmake`; the shell driver is
`scripts/emscripten-flags.sh`.

```bash
npm run build:wasm
WASM_DEBUG=1 npm run build:wasm
```

Artifacts are written to `public/wasm/` and committed. Gzip size > 200 KB fails
the build. CI rebuilds every module (including `video_stabilize` and
`media_engine`) and fails on `git diff -- public/wasm`.

The CMake tree lives in `$WASM_BUILD_DIR` (default `native/build/`).

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
| `time_stretch` | `time_stretch_tests` | tempo 1 is a near-copy (mono + stereo, bounded error); tempo 2 into half the length keeps pitch (zero-crossing) and level; identity `time_stretch_remap` matches constant tempo 1; bad args are rejected. |
| `video_stabilize` | `video_stabilize_tests` | static frames finalize to identity; a translated frame gives a `tx`/`ty` that follows the content shift (opposite the camera move) in normalized UV; matrices before finalize are identity; invalid `stab_create` is null. `stab_math.h` (similarity fit, smoother, motion → UV corrections) is tested directly on synthetic motion. |
| `media_engine` | `media_engine_host` | resampler THD+N goldens, chunk bit-equality, curve / pan parity. |

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
