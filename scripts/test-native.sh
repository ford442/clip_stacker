#!/usr/bin/env bash
# Build and run the native (host, non-Emscripten) DSP tests via ctest.
#
#   npm run test:native
#   HOST_BUILD_DIR=/tmp/host HOST_SANITIZE=0 npm run test:native
#
# Also writes compile_commands.json and points native/compile_commands.json at
# it unless that link already resolves to a WASM database (npm run build:wasm),
# which clangd should prefer: it carries em++'s sysroot and the wasm32 target.
# A missing, dangling, or host-tree link is refreshed, so clangd works without
# an Emscripten SDK and picks up newly added host targets.
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

LINK="$NATIVE/compile_commands.json"
HOST_DB="$BUILD_DIR/compile_commands.json"
# A WASM database is one whose compiler is em++/emcc.
if [ -f "$HOST_DB" ] && ! { [ -e "$LINK" ] && grep -qE '/em(\+\+|cc)[" ]' "$LINK"; }; then
  rm -f "$LINK"
  ln -s "$HOST_DB" "$LINK" 2>/dev/null || cp "$HOST_DB" "$LINK"
fi

cmake --build "$BUILD_DIR" --parallel
ctest --test-dir "$BUILD_DIR" --output-on-failure
