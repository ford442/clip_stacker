# Whisper (auto-caption) WASM module

`whisper_captions.cpp` wraps [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
so the browser can get **timed** segments, which whisper.cpp's own
`whisper.wasm` example does not expose. The C API it exports is documented in
`src/wasm/whisperModule.ts` — that file and this one must agree.

```bash
bash scripts/build-whisper.sh        # clones whisper.cpp, emits public/wasm/whisper.{js,wasm}
```

Deliberately **outside** `npm run build:wasm`:

- whisper.cpp is a large third-party tree, cloned on demand into
  `native/whisper/third_party/` rather than vendored.
- The output is tens of megabytes — the shared toolchain's 200 KB gzip budget
  applies to the small DSP modules, not to a speech model runtime.
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
