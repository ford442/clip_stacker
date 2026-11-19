#!/usr/bin/env bash
# clang-tidy over the native modules' own sources, with native/.clang-tidy
# (WarningsAsErrors: any finding fails). Reads the host build's
# compile_commands.json — the WASM one names em++ and its sysroot, which
# clang-tidy cannot follow — and configures that build first if it has none
# (configure only; nothing is compiled). Vendored third_party/ code and the
# tests are not linted (see native/.clang-tidy).
#
#   bash scripts/clang-tidy-native.sh
#   CLANG_TIDY=clang-tidy-18 TIDY_JOBS=4 bash scripts/clang-tidy-native.sh
#   HOST_BUILD_DIR=native/build-host-clang bash scripts/clang-tidy-native.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/native"
BUILD_DIR="${HOST_BUILD_DIR:-$NATIVE/build-host}"
case "$BUILD_DIR" in
  /*) ;;
  *) BUILD_DIR="$ROOT/$BUILD_DIR" ;;
esac
CLANG_TIDY="${CLANG_TIDY:-clang-tidy}"
JOBS="${TIDY_JOBS:-2}"

if ! command -v "$CLANG_TIDY" >/dev/null 2>&1; then
  echo "error: $CLANG_TIDY not found (set CLANG_TIDY=clang-tidy-<version>)" >&2
  exit 1
fi

DB="$BUILD_DIR/compile_commands.json"
if [ ! -f "$DB" ]; then
  cmake -S "$NATIVE" -B "$BUILD_DIR" \
    -DCLIP_STACKER_HOST_TESTS=ON \
    -DCMAKE_BUILD_TYPE="${HOST_BUILD_TYPE:-Release}" \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON >/dev/null
fi

mapfile -t files < <(grep -oE '"file": *"[^"]+"' "$DB" | sed -E 's/"file": *"([^"]+)"/\1/' \
  | grep -vE '/(third_party|tests|host_test)/' | sort -u)
if [ "${#files[@]}" -eq 0 ]; then
  echo "error: no first-party sources in $DB" >&2
  exit 1
fi

echo "clang-tidy ($("$CLANG_TIDY" --version | grep -oE 'version [0-9.]+' | head -1)) over ${#files[@]} files"
# One process per file, $JOBS at a time; xargs exits non-zero if any does
# (pipefail carries it past the filter that drops the per-file
# "N warnings generated." counts of suppressed system-header warnings).
printf '%s\0' "${files[@]}" \
  | xargs -0 -n 1 -P "$JOBS" "$CLANG_TIDY" -p "$BUILD_DIR" --quiet 2>&1 \
  | { grep -vE '^[0-9]+ warnings? generated\.$' || true; }
echo "clang-tidy: clean"
