#!/usr/bin/env bash
# Shared Emscripten flag notes + cmake driver for clip_stacker WASM modules.
#
# Source of truth for compiler/linker flags is native/toolchain.cmake.
# This file is the shell entry: configure, build, optional debug.
#
# WASM_BUILD_DIR (default native/build, native/build-debug for WASM_DEBUG=1)
# holds the CMake tree. Configure exports
# compile_commands.json there and links it to native/compile_commands.json
# (gitignored) for clangd — see native/.clangd.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$ROOT/native"

if ! command -v emcmake >/dev/null 2>&1 && ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc/emcmake not found. Install Emscripten and source emsdk_env.sh" >&2
  exit 1
fi

if ! command -v emcmake >/dev/null 2>&1; then
  echo "error: emcmake not found (need a full Emscripten SDK, not only emcc)" >&2
  exit 1
fi

# Supported SDK range. The committed public/wasm artifacts are built with the
# pinned version (native/emsdk-version, also what CI installs), and CI fails on
# any byte of drift — other versions build fine but produce different bytes.
EMSDK_MIN_VERSION="3.1.64"
EMSDK_MAX_MAJOR=6
EMSDK_PINNED_VERSION="$(tr -d '[:space:]' < "$NATIVE/emsdk-version")"

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

check_emcc_version() {
  local version
  version="$(emcc --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
  if [ -z "$version" ]; then
    echo "error: could not read the Emscripten version from 'emcc --version'" >&2
    exit 1
  fi
  if ! version_ge "$version" "$EMSDK_MIN_VERSION"; then
    echo "error: Emscripten $version is too old; clip_stacker needs >= $EMSDK_MIN_VERSION" >&2
    echo "       (pinned: $EMSDK_PINNED_VERSION — emsdk install $EMSDK_PINNED_VERSION && emsdk activate $EMSDK_PINNED_VERSION)" >&2
    exit 1
  fi
  if [ "${version%%.*}" -gt "$EMSDK_MAX_MAJOR" ]; then
    echo "warning: Emscripten $version is newer than the tested range (<= $EMSDK_MAX_MAJOR.x); if the build" >&2
    echo "         fails, use the pinned $EMSDK_PINNED_VERSION and report the breakage." >&2
  elif [ "$version" != "$EMSDK_PINNED_VERSION" ]; then
    echo "note: Emscripten $version builds fine, but the committed artifacts come from" >&2
    echo "      $EMSDK_PINNED_VERSION; CI's drift check will flag a commit of these bytes." >&2
  fi
}
check_emcc_version

WASM_DEBUG="${WASM_DEBUG:-0}"
BUILD_TYPE=Release
CMAKE_DEBUG=OFF
DEFAULT_BUILD_DIR="$NATIVE/build"
if [ "$WASM_DEBUG" = "1" ] || [ "${CMAKE_BUILD_TYPE:-}" = "Debug" ]; then
  BUILD_TYPE=Debug
  CMAKE_DEBUG=ON
  # Debug output lands in native/build-debug/wasm (see toolchain.cmake), never
  # over the committed release artifacts in public/wasm.
  DEFAULT_BUILD_DIR="$NATIVE/build-debug"
fi
BUILD_DIR="${WASM_BUILD_DIR:-$DEFAULT_BUILD_DIR}"

cmake_bin() {
  if command -v emcmake >/dev/null 2>&1; then
    emcmake cmake "$@"
  else
    cmake "$@"
  fi
}

build_bin() {
  if command -v emmake >/dev/null 2>&1; then
    emmake cmake --build "$@"
  else
    cmake --build "$@"
  fi
}

# Extra -D flags for the configure step (e.g. -DCLIP_STACKER_WHISPER=ON).
WASM_CMAKE_ARGS=()

configure_wasm_cmake() {
  mkdir -p "$BUILD_DIR"
  cmake_bin -S "$NATIVE" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
    -DCLIP_STACKER_WASM_DEBUG="$CMAKE_DEBUG" \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
    "${WASM_CMAKE_ARGS[@]}"
  link_compile_commands
}

# Point native/compile_commands.json at this build tree (symlink; copy where
# symlinks are unavailable). Machine-absolute paths stay out of git.
link_compile_commands() {
  local db="$BUILD_DIR/compile_commands.json"
  [ -f "$db" ] || return 0
  ln -sf "$db" "$NATIVE/compile_commands.json" 2>/dev/null \
    || cp "$db" "$NATIVE/compile_commands.json"
}

build_wasm_targets() {
  configure_wasm_cmake
  if [ "$#" -eq 0 ]; then
    build_bin "$BUILD_DIR" --parallel
  else
    build_bin "$BUILD_DIR" --parallel --target "$@"
  fi
}
