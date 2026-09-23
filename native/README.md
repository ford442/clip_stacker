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

DSP that has a host test suite is also built with the native compiler and run
through ctest (ASan + UBSan on by default), so numeric regressions fail without
going through the JS glue:

```bash
npm run test:native                      # configure + build + ctest in native/build-host
HOST_SANITIZE=0 npm run test:native      # plain Release build
native/build-host/media_engine/tests/media_engine_tests --list
```

Configuring `native/` with plain `cmake` requires `-DCLIP_STACKER_HOST_TESTS=ON`
(`host.cmake` holds the host flags); anything else must go through `emcmake`.
CI runs the same script in the `native-host` job.

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

No emsdk? `npm run test:native` links its host database instead (only when
`native/compile_commands.json` does not exist yet).
