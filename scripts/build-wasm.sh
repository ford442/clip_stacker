#!/usr/bin/env bash
# Build every clip_stacker WASM module via the shared CMake toolchain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=emscripten-flags.sh
source "$ROOT/scripts/emscripten-flags.sh"

if [ "$CMAKE_DEBUG" = "ON" ]; then
  OUT_DIR="$NATIVE/build-debug/wasm (served at /wasm-debug/, load with ?wasm_debug)"
else
  OUT_DIR="$ROOT/public/wasm"
fi
echo "Building all WASM modules (CMAKE_BUILD_TYPE=$BUILD_TYPE) → $OUT_DIR"
build_wasm_targets
echo "Done."
