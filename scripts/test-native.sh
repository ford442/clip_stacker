#!/usr/bin/env bash
# Build and run the native (host, non-Emscripten) DSP tests via ctest.
#
#   npm run test:native
#   HOST_BUILD_DIR=/tmp/host HOST_SANITIZE=0 npm run test:native
#
# Also writes compile_commands.json; when no WASM configure has linked one into
# native/ yet, links this one so clangd works without an Emscripten SDK.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/native"
BUILD_DIR="${HOST_BUILD_DIR:-$NATIVE/build-host}"
SANITIZE="${HOST_SANITIZE:-1}"
SANITIZE_FLAG=OFF
if [ "$SANITIZE" = "1" ]; then
  SANITIZE_FLAG=ON
fi

cmake -S "$NATIVE" -B "$BUILD_DIR" \
  -DCLIP_STACKER_HOST_TESTS=ON \
  -DCLIP_STACKER_HOST_SANITIZE="$SANITIZE_FLAG" \
  -DCMAKE_BUILD_TYPE="${HOST_BUILD_TYPE:-Release}" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON

if [ ! -e "$NATIVE/compile_commands.json" ]; then
  ln -s "$BUILD_DIR/compile_commands.json" "$NATIVE/compile_commands.json" 2>/dev/null \
    || cp "$BUILD_DIR/compile_commands.json" "$NATIVE/compile_commands.json"
fi

cmake --build "$BUILD_DIR" --parallel
ctest --test-dir "$BUILD_DIR" --output-on-failure
