# Audio analysis WASM module

C++ → Emscripten module providing real-time FFT band energy and beat onset
detection for WebGPU audio-reactive uniforms and timeline beat markers.

## Dependencies

- [kissfft](https://github.com/mborgerding/kissfft) (BSD-3-Clause) — vendored under `third_party/kissfft/`

## Build

Requires [Emscripten](https://emscripten.org/) (`emcc` on `PATH`):

```bash
./scripts/build-audio-analysis.sh
```

Outputs:

- `public/wasm/audio_analysis.js`
- `public/wasm/audio_analysis.wasm`

## API

See `audio_analysis.h`:

| Function | Purpose |
|----------|---------|
| `createAnalyzer(sampleRate, fftSize)` | Allocate analyzer |
| `analyzeFrame(handle, pcm, n, bands, beat)` | One hop → 8 band energies + beat envelope |
| `resetAnalyzer(handle)` | Clear onset state (seek) |
| `destroyAnalyzer(handle)` | Free |
| `getHopSize(handle)` | Recommended hop (~fftSize/2) |

TypeScript bindings live in `src/wasm/audioAnalysis.ts`.
