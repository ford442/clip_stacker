#!/usr/bin/env bash
#
# Push RIFE/ to the HuggingFace Space it is the source of truth for.
#
# The Space is a git repo on huggingface.co. This clones it, copies RIFE/ over
# the working tree, and pushes. Files the Space has but RIFE/ does not are left
# alone — remove those on the Space directly if you need to.
#
# Auth: set HF_TOKEN to a token with write access to the Space, or rely on an
# already-configured git credential helper.
#
# Usage:  scripts/deploy-rife-space.sh [--dry-run]

set -euo pipefail

SPACE_ID="1inkusFace/RIFE"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/RIFE"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if [[ ! -f "$SOURCE_DIR/app.py" ]]; then
  echo "error: $SOURCE_DIR/app.py not found" >&2
  exit 1
fi

echo "==> Syntax-checking app.py"
python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$SOURCE_DIR/app.py"

if [[ -n "${HF_TOKEN:-}" ]]; then
  REMOTE="https://user:${HF_TOKEN}@huggingface.co/spaces/${SPACE_ID}"
else
  echo "==> HF_TOKEN not set, relying on git credential helper"
  REMOTE="https://huggingface.co/spaces/${SPACE_ID}"
fi

WORKDIR="$(mktemp -d)"
# shellcheck disable=SC2064  # expand WORKDIR now, not at trap time
trap "rm -rf '$WORKDIR'" EXIT

echo "==> Cloning $SPACE_ID"
git clone --depth 1 "$REMOTE" "$WORKDIR/space" >/dev/null 2>&1 || {
  echo "error: could not clone the Space. Check HF_TOKEN and write access." >&2
  exit 1
}

echo "==> Copying RIFE/ into the Space working tree"
# --exclude keeps repo-only files (tests, __pycache__) off the Space.
rsync -a --exclude='.git' --exclude='tests' --exclude='__pycache__' \
  "$SOURCE_DIR"/ "$WORKDIR/space"/

cd "$WORKDIR/space"
if git diff --quiet && git diff --cached --quiet; then
  echo "==> Space already matches RIFE/, nothing to deploy"
  exit 0
fi

echo "==> Changes to deploy:"
git --no-pager diff --stat

if [[ "$DRY_RUN" == "1" ]]; then
  echo "==> --dry-run, not pushing"
  exit 0
fi

git add -A
git -c user.email="deploy@clip-stacker" -c user.name="clip-stacker deploy" \
  commit -q -m "Deploy from clip_stacker RIFE/ ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
git push

echo "==> Pushed. The Space will rebuild; first boot downloads RIFE weights and"
echo "    takes several minutes. Watch: https://huggingface.co/spaces/${SPACE_ID}"
