#!/usr/bin/env bash
# Build the Whisper speech-to-text WASM module (auto-captioning).
#
# Not part of `npm run build:wasm`, and its artifacts are NOT committed:
# whisper.cpp is a large third-party tree and the .wasm is far past the 200 KB
# gzip budget the DSP modules keep. Build it explicitly when you want
# auto-captioning, or leave it out — the app hides the feature when
# `public/wasm/whisper.js` is missing.
#
# The build itself is the opt-in `whisper_captions` CMake target
# (native/whisper/CMakeLists.txt) on the shared toolchain, so it gets the same
# flags, -DNDEBUG, and a compile_commands.json entry like every other module.
#
#   bash scripts/build-whisper.sh            # clone (if needed) + build
#   WHISPER_REPO=... WHISPER_REF=... bash scripts/build-whisper.sh
#   WASM_DEBUG=1 bash scripts/build-whisper.sh   # → native/build-debug/wasm
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=emscripten-flags.sh
source "$ROOT/scripts/emscripten-flags.sh"

THIRD_PARTY="$NATIVE/whisper/third_party"
SRC="$THIRD_PARTY/whisper.cpp"
WHISPER_REPO="${WHISPER_REPO:-https://github.com/ggerganov/whisper.cpp.git}"
WHISPER_REF="${WHISPER_REF:-v1.7.4}"

mkdir -p "$THIRD_PARTY"
if [ ! -d "$SRC" ]; then
  echo "Cloning whisper.cpp $WHISPER_REF → $SRC"
  git clone --depth 1 --branch "$WHISPER_REF" "$WHISPER_REPO" "$SRC"
fi

WASM_CMAKE_ARGS=(-DCLIP_STACKER_WHISPER=ON "-DCLIP_STACKER_WHISPER_DIR=$SRC")
echo "Building whisper WASM (CMAKE_BUILD_TYPE=$BUILD_TYPE)"
build_wasm_targets whisper_captions

echo "Done. Put a ggml model at public/models/ggml-tiny-q5_1.bin (or set the"
echo "model URL in the Captions tab) to enable auto-captioning."
