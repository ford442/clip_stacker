#!/usr/bin/env bash
# Build the libFuzzer targets with clang (ASan + UBSan incl. float-cast-overflow)
# and run each for a while.
#
#   npm run fuzz:native                  # 60 s per target
#   FUZZ_SECONDS=600 npm run fuzz:native # a longer soak
#
# Corpora live in native/build-fuzz/corpus/<target> (not committed); a crash
# leaves crash-* next to it: rerun with `native/build-fuzz/media_engine/tests/fx_fuzz crash-...`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${FUZZ_BUILD_DIR:-$ROOT/native/build-fuzz}"
SECONDS_PER_TARGET="${FUZZ_SECONDS:-60}"

CC="${CC:-clang}" CXX="${CXX:-clang++}" cmake -S "$ROOT/native" -B "$BUILD_DIR" \
  -DCLIP_STACKER_HOST_TESTS=ON \
  -DCLIP_STACKER_HOST_SANITIZE=ON \
  -DCLIP_STACKER_HOST_FUZZ=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" --target fx_fuzz --parallel

for target in fx_fuzz; do
  corpus="$BUILD_DIR/corpus/$target"
  mkdir -p "$corpus"
  bin="$(find "$BUILD_DIR" -type f -name "$target" -perm -u+x | head -1)"
  echo "== $target for ${SECONDS_PER_TARGET}s"
  (cd "$BUILD_DIR" && "$bin" -max_total_time="$SECONDS_PER_TARGET" -max_len=65536 -print_final_stats=1 "$corpus")
done
