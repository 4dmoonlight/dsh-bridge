#!/usr/bin/env bash
# Publish dsh-relay-sync to GitHub once credentials exist.
#
#   gh auth login            # or: export GITHUB_TOKEN=...
#   bash scripts/publish.sh [OWNER] [--private]
#
# Creates the repo if missing, points the OWNER placeholders in the docs at the
# real account, commits that rewrite, and pushes main.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAME="dsh-relay-sync"
OWNER=""
VISIBILITY="public"

for argument in "$@"; do
  case "$argument" in
    --private) VISIBILITY="private" ;;
    --public) VISIBILITY="public" ;;
    -*) echo "unknown flag: $argument" >&2; exit 2 ;;
    *) OWNER="$argument" ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required: brew install gh && gh auth login" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "using GITHUB_TOKEN"
    export GH_TOKEN="$GITHUB_TOKEN"
  else
    echo "not authenticated: run 'gh auth login' or export GITHUB_TOKEN" >&2
    exit 1
  fi
fi

if [ -z "$OWNER" ]; then
  OWNER="$(gh api user -q .login)"
fi
echo "owner: $OWNER   repo: $NAME   visibility: $VISIBILITY"

python3 - "$OWNER" <<'PY'
import pathlib, sys
owner = sys.argv[1]
changed = []
for path in pathlib.Path(".").rglob("*.md"):
    if ".git" in path.parts:
        continue
    text = path.read_text(encoding="utf-8")
    new = text.replace("github.com/OWNER/", f"github.com/{owner}/")
    if new != text:
        path.write_text(new, encoding="utf-8")
        changed.append(str(path))
print("rewrote:", ", ".join(changed) if changed else "nothing")
PY

if ! git diff --quiet; then
  git add -A
  git -c user.name="$(git config --global user.name)" \
      -c user.email="$(git config --global user.email)" \
      commit -q -m "docs: point install URLs at $OWNER"
fi

if ! gh repo view "$OWNER/$NAME" >/dev/null 2>&1; then
  gh repo create "$OWNER/$NAME" "--$VISIBILITY" \
    --source=. --remote=origin \
    --description "Relay-mediated session sync for DeepSeek Harness on macOS"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/$OWNER/$NAME.git"
else
  git remote add origin "https://github.com/$OWNER/$NAME.git"
fi
git push -u origin main

echo
echo "published: https://github.com/$OWNER/$NAME"
echo "verify:    curl -fsSL https://raw.githubusercontent.com/$OWNER/$NAME/main/install.sh | head -5"
