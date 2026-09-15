#!/usr/bin/env bash
# Build the audio analysis WASM module (shared CMake toolchain).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=emscripten-flags.sh
source "$ROOT/scripts/emscripten-flags.sh"

echo "Building audio_analysis WASM → $ROOT/public/wasm"
build_wasm_targets audio_analysis
echo "Done."
