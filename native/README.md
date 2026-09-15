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
