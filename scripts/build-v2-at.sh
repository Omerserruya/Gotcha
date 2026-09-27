#!/usr/bin/env bash
#
# Build the /v2 image FROM A COMMIT, not from the working tree.
#
# ── WHY THIS EXISTS, AND IT COST A FALSE AUDIT RESULT ─────────────────────
#
# `docker compose build frontend-v2` uses `context: ../redesign` — the shared
# working tree. Two sessions work in that one checkout: Frontend edits it and
# I build from it to verify their last commit. Those two activities cannot
# safely overlap, and on 2026-09-27 they did:
#
#   18:07:18  git status  ->  clean
#   18:07:2x  COPY . .    ->  captured `displayPriceSchema`, a half-written
#                             Wave 2 symbol that exists in NO commit
#   18:08     tsc         ->  clean
#   18:1x     git status  ->  4 modified files in billing/pricing
#
# Every one of those readings was true, of a different tree. The build failed
# with seven type errors in source that was never committed, which reads as
# "Frontend's commit does not compile" and is not what happened.
#
# A build from the working tree cannot be attributed to a commit. So this one
# does not: `git archive <ref>` materialises exactly what is committed, and
# nothing anybody is typing can reach it.
#
# ★ IT ALSO MEANS A GREEN RESULT NAMES A REF. That is the whole point — the
#   question "is /v2 serving Wave 1" has an answer only if the image can be
#   traced to `b439a42` rather than to "whatever was on disk at 18:07".
#
# The build args are copied from `docker compose config frontend-v2` and are
# checked against it on every run, because they are inlined by `next build`
# and a drift between the two is invisible until a screen misbehaves.
#
# Usage:  build-v2-at.sh [ref]      (default: HEAD of rebrand/v2)
set -euo pipefail

REPO=/home/ocs/projects/redesign
COMPOSE=/home/ocs/projects/ChatCenter
REF="${1:-rebrand/v2}"
SHA=$(git -C "$REPO" rev-parse --short "$REF")
SRC=$(mktemp -d /tmp/claude-1000/v2src-XXXXXX)
trap 'rm -rf "$SRC"' EXIT

echo "── materialising $REF ($SHA) ──"
git -C "$REPO" archive "$REF" | tar -x -C "$SRC"

# The args are load-bearing and inlined at build time. Read them from compose
# rather than restating them, so this cannot drift from the service definition.
mapfile -t ARGS < <(
  cd "$COMPOSE" && docker compose config frontend-v2 \
    | sed -n '/^ *args:$/,/^ *environment:$/p' \
    | sed -n 's/^ *\(NEXT_PUBLIC_[A-Z_]*\): \(.*\)$/--build-arg\n\1=\2/p'
)
if [ "${#ARGS[@]}" -eq 0 ]; then
  echo "refusing: read no NEXT_PUBLIC_* build args out of compose" >&2
  exit 1
fi
printf '── build args ──\n'
printf '   %s\n' "${ARGS[@]}" | grep -v '^   --build-arg$'

docker build "${ARGS[@]}" -t chatcenter-frontend-v2:latest -t "chatcenter-frontend-v2:$SHA" "$SRC"

echo
echo "── built chatcenter-frontend-v2:$SHA ──"
echo "   recreate with:  docker compose up -d --no-deps frontend-v2"
echo "   (--no-deps, because recreating a platform service hands it a new IP"
echo "    and the gateway resolves its upstreams once, at startup.)"
