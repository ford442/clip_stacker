#!/usr/bin/env bash
# Build the libFuzzer targets with clang (ASan + UBSan incl. float-cast-overflow)
# and run each for a while.
#
#   npm run fuzz:native                       # 60 s per target
#   FUZZ_SECONDS=600 npm run fuzz:native      # a longer soak (every target)
#   FUZZ_SECONDS_MIX=300 npm run fuzz:native  # one target's budget (_FX, _MIX, _STAB)
#   FUZZ_TARGETS="stab_fuzz" npm run fuzz:native
#
# Targets:
#   fx_fuzz   — bus graph + insert chains (effect rows, raw parameter bits)
#   mix_fuzz  — mix_timeline_audio_range: random schedules, slices and a
#               random pcm_floats length (the cs_span_ok contract), plus
#               chunk invariance
#   stab_fuzz — the stabilizer's C API: random sizes, radii, textures, motion
#
# Corpora live in native/build-fuzz/corpus/<target> (not committed); a crash
# leaves crash-* in native/build-fuzz: rerun with
# `native/build-fuzz/media_engine/tests/fx_fuzz crash-...` (find the binary
# with `find native/build-fuzz -name <target> -type f`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${FUZZ_BUILD_DIR:-$ROOT/native/build-fuzz}"
SECONDS_PER_TARGET="${FUZZ_SECONDS:-60}"
TARGETS="${FUZZ_TARGETS:-fx_fuzz mix_fuzz stab_fuzz}"

CC="${CC:-clang}" CXX="${CXX:-clang++}" cmake -S "$ROOT/native" -B "$BUILD_DIR" \
  -DCLIP_STACKER_HOST_TESTS=ON \
  -DCLIP_STACKER_HOST_SANITIZE=ON \
  -DCLIP_STACKER_HOST_FUZZ=ON \
  -DCMAKE_BUILD_TYPE=Release
# shellcheck disable=SC2086 # TARGETS is a list
cmake --build "$BUILD_DIR" --target $TARGETS --parallel

for target in $TARGETS; do
  # fx_fuzz -> FUZZ_SECONDS_FX, mix_fuzz -> FUZZ_SECONDS_MIX, ...
  budget_var="FUZZ_SECONDS_$(echo "${target%_fuzz}" | tr '[:lower:]' '[:upper:]')"
  seconds="${!budget_var:-$SECONDS_PER_TARGET}"
  corpus="$BUILD_DIR/corpus/$target"
  mkdir -p "$corpus"
  bin="$(find "$BUILD_DIR" -type f -name "$target" -perm -u+x | head -1)"
  if [ -z "$bin" ]; then
    echo "error: no $target binary under $BUILD_DIR" >&2
    exit 1
  fi
  echo "== $target for ${seconds}s"
  (cd "$BUILD_DIR" && "$bin" -max_total_time="$seconds" -max_len=65536 -print_final_stats=1 "$corpus")
done
