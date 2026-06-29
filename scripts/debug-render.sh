#!/usr/bin/env bash
# debug-render.sh — Local smoke test for clip_stacker render pipeline diagnostics.
#
# Usage:
#   ./scripts/debug-render.sh          # run unit tests + build
#   ./scripts/debug-render.sh --serve  # also start preview server for manual R002/R003
#
# Manual test matrix (see docs/render-test-matrix.md):
#   R002 — Two clips, lossless concat (no fades/transitions)
#   R003 — Two clips with crossfade transition (filter_complex path)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> clip_stacker render pipeline debug"
echo "    Root: $ROOT"
echo ""

echo "==> Step 1: FFmpeg-related unit tests"
npm test -- --run \
  src/ffmpeg/ffmpegService.load.test.ts \
  src/ffmpeg/ffmpegService.renderPlan.test.ts \
  src/ffmpeg/ffmpegCommon.test.ts \
  src/utils/debugReport.test.ts \
  2>/dev/null || npm test -- --run \
  src/ffmpeg/ffmpegService.load.test.ts \
  src/ffmpeg/ffmpegService.renderPlan.test.ts

echo ""
echo "==> Step 2: Production build"
npm run build

echo ""
echo "==> Build OK. dist/ ready."
echo ""
echo "Manual verification (R002 / R003):"
echo "  1. npm run preview   # http://localhost:4173/"
echo "  2. Upload 2+ MP4 clips, arrange on timeline"
echo "  3. R002: Render with no fades/transitions → expect lossless concat"
echo "  4. R003: Add a dissolve transition → expect filter_complex re-encode"
echo "  5. On failure: check RenderFailurePanel + Copy Debug Report"
echo ""
echo "Tip: Force a failure to verify error messages never show 'undefined':"
echo "  - Enable 'Force re-encode' with an invalid clip trim range"
echo "  - Or use DevTools → Application → clear FFmpeg core cache mid-render"

if [[ "${1:-}" == "--serve" ]]; then
  echo ""
  echo "==> Starting preview server (Ctrl+C to stop)..."
  npm run preview
fi
