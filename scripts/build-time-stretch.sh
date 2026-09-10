#!/usr/bin/env bash
# Build the pitch-preserving WSOLA time-stretch WASM module with Emscripten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/time_stretch"
OUT="$ROOT/public/wasm"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten and source emsdk_env.sh" >&2
  exit 1
fi

mkdir -p "$OUT"

# Flag notes:
#   -msimd128        vectorises the WSOLA overlap-add inner loop.
#   -flto / --closure 1  as in build-audio-analysis.sh.
#   MAXIMUM_MEMORY   NOT 64 MB: wasmRemapPlanar() copies the whole clip's PCM in
#                    and out through the wasm heap, so one minute of 48 kHz stereo
#                    already needs ~46 MB. 512 MB bounds the heap without failing
#                    on ordinary clip lengths.
echo "Building time_stretch WASM → $OUT"
em++ \
  "$SRC/time_stretch.cpp" \
  -I"$SRC" \
  -O3 \
  -DNDEBUG \
  -msimd128 \
  -flto \
  -fno-exceptions \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createTimeStretchModule \
  -s ENVIRONMENT=web,worker,node \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4194304 \
  -s MAXIMUM_MEMORY=536870912 \
  -s EXPORTED_FUNCTIONS='["_time_stretch_remap","_time_stretch_constant","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8"]' \
  -s NO_EXIT_RUNTIME=1 \
  --closure 1 \
  -o "$OUT/time_stretch.js"

wasm_bytes=$(wc -c < "$OUT/time_stretch.wasm" | tr -d ' ')
js_bytes=$(wc -c < "$OUT/time_stretch.js" | tr -d ' ')
gz_bytes=$(gzip -c "$OUT/time_stretch.wasm" | wc -c | tr -d ' ')
echo "time_stretch.wasm: ${wasm_bytes} bytes (gzip ~${gz_bytes})"
echo "time_stretch.js:   ${js_bytes} bytes"
if [ "$gz_bytes" -gt 204800 ]; then
  echo "warning: gzipped WASM exceeds 200 KB acceptance target (${gz_bytes})" >&2
fi
echo "Done."
