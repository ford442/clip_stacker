# Media engine WASM (timeline PCM mix)

Phase-1 C++ mix/resample for export premix. WebGPU still owns pixels; this
module never touches video frames.

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

Gzipped `.wasm` must stay under **200 KB** (`scripts/wasm-size-check.sh` fails the build otherwise).

## API

`mix_timeline_audio` — schedule + concatenated interleaved f32 PCM → interleaved stereo (or mono) mix at a target sample rate. Linear resampling; polyphase is a later follow-up.

TypeScript: `src/wasm/mediaEngine.ts` (`mixTimelineAudio`). Load failure disables the path; export premix falls back to `OfflineAudioContext`.

Kill switch: `?no_media_engine`.
