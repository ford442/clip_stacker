#!/usr/bin/env bash
# Fail if a committed WASM artifact's gzip size exceeds the 200 KB budget.
set -euo pipefail

WASM_PATH="${1:-}"
BUDGET="${WASM_GZIP_BUDGET:-204800}"

if [ -z "$WASM_PATH" ] || [ ! -f "$WASM_PATH" ]; then
  echo "error: wasm-size-check: missing file: ${WASM_PATH:-<none>}" >&2
  exit 1
fi

wasm_bytes=$(wc -c < "$WASM_PATH" | tr -d ' ')
js_path="${WASM_PATH%.wasm}.js"
js_bytes=0
if [ -f "$js_path" ]; then
  js_bytes=$(wc -c < "$js_path" | tr -d ' ')
fi
gz_bytes=$(gzip -c "$WASM_PATH" | wc -c | tr -d ' ')
name=$(basename "$WASM_PATH")

echo "${name}: ${wasm_bytes} bytes (gzip ${gz_bytes}; js ${js_bytes})"

if [ "$gz_bytes" -gt "$BUDGET" ]; then
  echo "error: gzipped ${name} exceeds ${BUDGET} byte budget (${gz_bytes})" >&2
  exit 1
fi
