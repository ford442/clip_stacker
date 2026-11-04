#!/usr/bin/env bash
# Build and run the native (host, non-Emscripten) DSP tests via ctest.
#
#   npm run test:native
#   HOST_BUILD_DIR=/tmp/host HOST_SANITIZE=0 npm run test:native
#
#   HOST_CTEST_ARGS="-L pr" npm run test:native   # what PR CI runs (skips the nightly battery)
#
# Also writes compile_commands.json and points native/compile_commands.json at
# it unless that link already resolves to a WASM database (npm run build:wasm)
# that covers every source the host build compiles. clangd prefers the WASM
# one (em++'s sysroot, the wasm32 target), but a WASM database configured
# before a source existed (say fx/bus.cpp) leaves clangd blind to that file,
# so a stale one is replaced by the host database, with a warning. A missing,
# dangling, or host-tree link is refreshed too, so clangd works without an
# Emscripten SDK and picks up newly added targets.
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

# Module sources a database compiles (test, tool and fuzz files are host-only).
db_sources() {
  grep -oE '"file": *"[^"]+"' "$1" | sed -E 's/"file": *"([^"]+)"/\1/' \
    | grep -vE '/(tests|tools|host_test)/' | sort -u
}

relink=0
if [ -f "$HOST_DB" ]; then
  # A WASM database is one whose compiler is em++/emcc.
  if [ -e "$LINK" ] && grep -qE '/em(\+\+|cc)[" ]' "$LINK"; then
    missing="$(comm -23 <(db_sources "$HOST_DB") <(db_sources "$LINK"))"
    if [ -n "$missing" ]; then
      echo "warning: native/compile_commands.json is a WASM database that predates:" >&2
      echo "$missing" | sed 's/^/           /' >&2
      echo "         clangd would not index those files; linking the (newer) host database" >&2
      echo "         instead. Run 'npm run build:wasm' to get a current WASM database back." >&2
      relink=1
    fi
  else
    relink=1
  fi
fi
if [ "$relink" = "1" ]; then
  rm -f "$LINK"
  ln -s "$HOST_DB" "$LINK" 2>/dev/null || cp "$HOST_DB" "$LINK"
fi

cmake --build "$BUILD_DIR" --parallel
# shellcheck disable=SC2086 # HOST_CTEST_ARGS is a list of ctest flags
ctest --test-dir "$BUILD_DIR" --output-on-failure ${HOST_CTEST_ARGS:-}
