#!/usr/bin/env bash
# Build the timeline PCM mix / resample media-engine WASM module.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=emscripten-flags.sh
source "$ROOT/scripts/emscripten-flags.sh"

echo "Building media_engine WASM → $ROOT/public/wasm"
build_wasm_targets media_engine
echo "Done."
