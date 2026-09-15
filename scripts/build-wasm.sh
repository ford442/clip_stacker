#!/usr/bin/env bash
# Build every clip_stacker WASM module via the shared CMake toolchain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=emscripten-flags.sh
source "$ROOT/scripts/emscripten-flags.sh"

echo "Building all WASM modules (CMAKE_BUILD_TYPE=$BUILD_TYPE) → $ROOT/public/wasm"
build_wasm_targets
echo "Done."
