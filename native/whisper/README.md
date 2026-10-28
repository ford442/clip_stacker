# Whisper (auto-caption) WASM module

`whisper_captions.cpp` wraps [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
so the browser can get **timed** segments, which whisper.cpp's own
`whisper.wasm` example does not expose. The C API it exports is documented in
`src/wasm/whisperModule.ts` — that file and this one must agree.

```bash
npm run build:whisper        # clones whisper.cpp (pinned tag), emits public/wasm/whisper.{js,wasm}
```

The build is the opt-in `whisper_captions` target in `native/whisper/CMakeLists.txt`
(`-DCLIP_STACKER_WHISPER=ON`), on the shared toolchain: whisper.cpp's own CMake
builds `whisper` + `ggml` (so upstream layout changes, like the CPU backend
moving to `ggml/src/ggml-cpu/` in 1.7, need no edit here), Release adds
`-DNDEBUG`, and its sources land in `compile_commands.json`.

It is the one module built with pthreads: ggml splits each graph across a pool
of `CLIP_STACKER_WHISPER_THREADS` (4) workers created when the module loads —
a worker blocked inside `whisperTranscribe` cannot wait for new pthread workers
to start, so the wrapper never asks for more threads than the pool holds. The
page is already cross-origin isolated for FFmpeg, so SharedArrayBuffer is
available. It also links C++ throw support (whisper.cpp throws); catching stays
off, so a throw still aborts the module.

Deliberately **outside** `npm run build:wasm`:

- whisper.cpp is a large third-party tree, cloned on demand into
  `native/whisper/third_party/` rather than vendored.
- The output is ~1 MB of WASM plus the model — the 200 KB gzip budget applies
  to the small DSP modules, not to a speech model runtime.
- The artifacts are **not committed**. Without them the app simply hides
  auto-captioning (`whisperCaptionProvider.isAvailable()` → false), exactly
  like the other optional WASM features.

## Weights

Weights are data, not code, and are fetched separately — by default from
`public/models/ggml-tiny-q5_1.bin`, cached in IndexedDB after the first load.
OpenAI's Whisper weights are MIT-licensed; `ggml` conversions are published by
the whisper.cpp project.

Only `tiny` / `base` are realistic in a tab. `small` and up belong on a server
— point the `whisper-http` provider at one instead.

## Licensing

whisper.cpp is MIT. Nothing from it is vendored in this repo; the build script
clones it at a pinned tag.
