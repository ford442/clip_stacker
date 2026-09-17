#!/usr/bin/env bash
# Build the Whisper speech-to-text WASM module (auto-captioning).
#
# Unlike the other native modules this one is NOT part of `npm run build:wasm`
# and its artifacts are NOT committed: whisper.cpp is a large third-party tree
# and the resulting .wasm is far past the 200 KB gzip budget the shared
# toolchain enforces. Build it explicitly when you want auto-captioning, or
# leave it out — the app hides the feature when `public/wasm/whisper.js` is
# missing.
#
#   bash scripts/build-whisper.sh            # clone + build tiny-compatible module
#   WHISPER_REPO=... WHISPER_REF=... bash scripts/build-whisper.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THIRD_PARTY="$ROOT/native/whisper/third_party"
SRC="$THIRD_PARTY/whisper.cpp"
OUT="$ROOT/public/wasm"
WHISPER_REPO="${WHISPER_REPO:-https://github.com/ggerganov/whisper.cpp.git}"
WHISPER_REF="${WHISPER_REF:-v1.7.4}"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten and source emsdk_env.sh" >&2
  exit 1
fi

mkdir -p "$THIRD_PARTY" "$OUT"
if [ ! -d "$SRC" ]; then
  echo "Cloning whisper.cpp $WHISPER_REF → $SRC"
  git clone --depth 1 --branch "$WHISPER_REF" "$WHISPER_REPO" "$SRC"
fi

echo "Building whisper WASM → $OUT/whisper.js"
emcc \
  -O3 -msimd128 -flto \
  -I "$SRC/include" -I "$SRC/ggml/include" -I "$SRC/src" \
  "$ROOT/native/whisper/whisper_captions.cpp" \
  "$SRC"/src/*.cpp \
  "$SRC"/ggml/src/*.c \
  "$SRC"/ggml/src/*.cpp \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createWhisperModule \
  -s ENVIRONMENT=web,worker \
  -s USE_ES6_IMPORT_META=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=2147483648 \
  -s FILESYSTEM=0 \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPF32","HEAPU8"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_whisperInit","_whisperFree","_whisperTranscribe","_whisperSegmentStartMs","_whisperSegmentEndMs","_whisperSegmentText"]' \
  -o "$OUT/whisper.js"

echo "Done. Put a ggml model at public/models/ggml-tiny-q5_1.bin (or set the"
echo "model URL in the Captions tab) to enable auto-captioning."
