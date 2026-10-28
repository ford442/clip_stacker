#!/usr/bin/env bash
# Build the sparse-optical-flow video stabilization WASM module (shared CMake toolchain).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=emscripten-flags.sh
source "$ROOT/scripts/emscripten-flags.sh"

echo "Building video_stabilize WASM → $ROOT/public/wasm"
build_wasm_targets video_stabilize
echo "Done."
