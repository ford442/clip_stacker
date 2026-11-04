#!/usr/bin/env bash
# Regenerate native/media_engine/src/fx/true_peak_taps.inc from the resampler's
# Kaiser-sinc design (host compiler; no Emscripten needed). Run after changing
# kSincTaps / kSincPhases / kSincRolloff / kSincKaiserBeta; the host test
# `true_peak_taps_match_sinc_table` fails until you do.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${HOST_BUILD_DIR:-$ROOT/native/build-host}"
cmake -S "$ROOT/native" -B "$BUILD_DIR" -DCLIP_STACKER_HOST_TESTS=ON >/dev/null
cmake --build "$BUILD_DIR" --target gen_true_peak_taps --parallel
"$BUILD_DIR/media_engine/gen_true_peak_taps" > "$ROOT/native/media_engine/src/fx/true_peak_taps.inc"
echo "Wrote native/media_engine/src/fx/true_peak_taps.inc"
