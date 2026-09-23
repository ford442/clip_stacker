#!/usr/bin/env bash
# Shared Emscripten flag notes + cmake driver for clip_stacker WASM modules.
#
# Source of truth for compiler/linker flags is native/toolchain.cmake.
# This file is the shell entry: configure, build, optional debug.
#
# WASM_BUILD_DIR (default native/build) holds the CMake tree. Configure exports
# compile_commands.json there and links it to native/compile_commands.json
# (gitignored) for clangd — see native/.clangd.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$ROOT/native"
BUILD_DIR="${WASM_BUILD_DIR:-$NATIVE/build}"

if ! command -v emcmake >/dev/null 2>&1 && ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc/emcmake not found. Install Emscripten and source emsdk_env.sh" >&2
  exit 1
fi

if ! command -v emcmake >/dev/null 2>&1; then
  echo "error: emcmake not found (need a full Emscripten SDK, not only emcc)" >&2
  exit 1
fi

WASM_DEBUG="${WASM_DEBUG:-0}"
BUILD_TYPE=Release
CMAKE_DEBUG=OFF
if [ "$WASM_DEBUG" = "1" ] || [ "${CMAKE_BUILD_TYPE:-}" = "Debug" ]; then
  BUILD_TYPE=Debug
  CMAKE_DEBUG=ON
fi

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

configure_wasm_cmake() {
  mkdir -p "$BUILD_DIR" "$ROOT/public/wasm"
  cmake_bin -S "$NATIVE" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
    -DCLIP_STACKER_WASM_DEBUG="$CMAKE_DEBUG" \
    -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
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
