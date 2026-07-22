#!/usr/bin/env bash
# Build the audio analysis WASM module with Emscripten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/audio_analysis"
OUT="$ROOT/public/wasm"
KISS="$SRC/third_party/kissfft"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten and source emsdk_env.sh" >&2
  exit 1
fi

mkdir -p "$OUT"

echo "Building audio_analysis WASM → $OUT"
emcc \
  "$SRC/audio_analysis.cpp" \
  "$KISS/kiss_fft.c" \
  -I"$SRC" \
  -I"$KISS" \
  -O3 \
  -DNDEBUG \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createAudioAnalysisModule \
  -s ENVIRONMENT=web,worker,node \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s EXPORTED_FUNCTIONS='["_createAnalyzer","_analyzeFrame","_resetAnalyzer","_destroyAnalyzer","_getHopSize","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8"]' \
  -s NO_EXIT_RUNTIME=1 \
  -o "$OUT/audio_analysis.js"

# Report sizes (raw + gzip estimate)
wasm_bytes=$(wc -c < "$OUT/audio_analysis.wasm" | tr -d ' ')
js_bytes=$(wc -c < "$OUT/audio_analysis.js" | tr -d ' ')
gz_bytes=$(gzip -c "$OUT/audio_analysis.wasm" | wc -c | tr -d ' ')
echo "audio_analysis.wasm: ${wasm_bytes} bytes (gzip ~${gz_bytes})"
echo "audio_analysis.js:   ${js_bytes} bytes"
if [ "$gz_bytes" -gt 204800 ]; then
  echo "warning: gzipped WASM exceeds 200 KB acceptance target (${gz_bytes})" >&2
fi
echo "Done."
