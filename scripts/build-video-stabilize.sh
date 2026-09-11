#!/usr/bin/env bash
# Build the sparse-optical-flow video stabilization WASM module with Emscripten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/video_stabilize"
OUT="$ROOT/public/wasm"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten and source emsdk_env.sh" >&2
  exit 1
fi

mkdir -p "$OUT"

# Flag notes:
#   -msimd128        vectorises the Lucas-Kanade window reductions and the
#                    structure-tensor accumulation, the two inner loops.
#   -flto            as in build-audio-analysis.sh.
#   FILESYSTEM=0     the module never touches a file; frames arrive as heap bytes.
#   MAXIMUM_MEMORY   analysis runs on downscaled frames (~480 px long edge) and
#                    only ever holds one pyramid plus the per-frame motion list,
#                    so 128 MB is a generous ceiling.
echo "Building video_stabilize WASM → $OUT"
em++ \
  "$SRC/video_stabilize.cpp" \
  -I"$SRC" \
  -O3 \
  -DNDEBUG \
  -msimd128 \
  -flto \
  -fno-exceptions \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createVideoStabilizeModule \
  -s ENVIRONMENT=web,worker,node \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=4194304 \
  -s MAXIMUM_MEMORY=134217728 \
  -s EXPORTED_FUNCTIONS='["_stab_create","_stab_push_frame","_stab_frame_count","_stab_finalize","_stab_get_matrix","_stab_get_zoom","_stab_get_max_correction","_stab_apply_warp","_stab_destroy","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
  -s NO_EXIT_RUNTIME=1 \
  --closure 1 \
  -o "$OUT/video_stabilize.js"

wasm_bytes=$(wc -c < "$OUT/video_stabilize.wasm" | tr -d ' ')
js_bytes=$(wc -c < "$OUT/video_stabilize.js" | tr -d ' ')
gz_bytes=$(gzip -c "$OUT/video_stabilize.wasm" | wc -c | tr -d ' ')
echo "video_stabilize.wasm: ${wasm_bytes} bytes (gzip ~${gz_bytes})"
echo "video_stabilize.js:   ${js_bytes} bytes"
if [ "$gz_bytes" -gt 204800 ]; then
  echo "warning: gzipped WASM exceeds 200 KB acceptance target (${gz_bytes})" >&2
fi
echo "Done."
