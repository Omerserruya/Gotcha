#!/usr/bin/env bash
# Which running services are NOT running the source in this checkout.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY /health's BUILD_SHA CANNOT ANSWER THIS ON DEV
#
# Every dev service reports build:"dev", because docker-compose.yml passes
# BUILD_SHA:${BUILD_SHA:-dev} and nothing sets it. The string is identical
# before and after any rebuild, so a gate comparing it would pass every time
# and catch nothing - a control that cannot fail.
#
# And for a BIND-MOUNTED service the image sha is the wrong question anyway.
# `ai` mounts services/ai/src into the container, so the CHECKOUT decides what
# the code is; the image it was built from is irrelevant. What makes it stale
# is that `tsx` runs WITHOUT `watch`, so the process holds whatever the modules
# were when it started.
#
# So there are two different staleness questions, and this asks each service
# the one that applies to it:
#
#   bind-mounted  source newer than the PROCESS START  -> restart  (cheap)
#   baked image   source newer than the IMAGE BUILD    -> rebuild  (a deploy
#                                                          decision, not ours)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

SHARED="packages/shared/src"
stale=0

# Newest CONTENT change in the given dirs, as epoch seconds.
#
# Git commit time, not file mtime. A checkout, a rebase or a stray `touch`
# rewrites mtimes without changing a byte, and an mtime-based gate then reports
# every service stale and is ignored within a day. Uncommitted edits are added
# back in separately, because those are real changes git has no time for yet.
newest_change() {
  local newest=0 t d
  for d in "$@"; do
    [ -d "$d" ] || continue
    t=$(git log -1 --format=%ct -- "$d" 2>/dev/null)
    [ -n "$t" ] && [ "$t" -gt "$newest" ] && newest=$t
    # An uncommitted edit in this tree: use its mtime, since git has no time
    # for work that is not committed yet.
    if [ -n "$(git status --porcelain -- "$d" 2>/dev/null)" ]; then
      t=$(git status --porcelain -- "$d" 2>/dev/null | awk '{print $NF}' | while read -r f; do
            [ -f "$f" ] && stat -c %Y "$f"; done | sort -rn | head -1)
      [ -n "$t" ] && [ "$t" -gt "$newest" ] && newest=$t
    fi
  done
  echo "$newest"
}

printf '%-18s %-9s %-20s %-20s %s\n' SERVICE KIND "RUNNING SINCE" "NEWEST CHANGE" VERDICT
for dir in services/*/; do
  svc=$(basename "$dir")
  cid="chatcenter-${svc}-1"
  docker inspect "$cid" >/dev/null 2>&1 || continue

  started=$(docker inspect "$cid" --format '{{.State.StartedAt}}' 2>/dev/null)
  started_s=$(date -d "$started" +%s 2>/dev/null || echo 0)
  image=$(docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null)
  built_s=$(date -d "$(docker inspect "$image" --format '{{.Created}}' 2>/dev/null)" +%s 2>/dev/null || echo 0)

  # Does the container mount this service's source? Then the checkout wins.
  if docker inspect "$cid" --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null | grep -q "/app/services/${svc}/src"; then
    kind=mounted; ref=$started_s; fix="RESTART"
  else
    kind=baked;   ref=$built_s;   fix="REBUILD"
  fi

  src_s=$(newest_change "$dir/src" "$SHARED")
  if [ "$src_s" -gt "$ref" ]; then
    verdict="STALE - needs $fix"
    stale=$((stale + 1))
  else
    verdict="current"
  fi
  printf '%-18s %-9s %-20s %-20s %s\n' "$svc" "$kind" \
    "$(date -d "@$ref" '+%Y-%m-%d %H:%M:%S')" "$(date -d "@$src_s" '+%Y-%m-%d %H:%M:%S')" "$verdict"
done

echo
if [ "$stale" -gt 0 ]; then
  echo "$stale service(s) are not running this checkout. A capture against them verifies the OLD code."
  echo "A RESTART is cheap and reversible. A REBUILD picks up every uncommitted change in the tree"
  echo "and is a deployment decision on a shared box - ask before doing one."
  exit 1
fi
echo "Every running service matches this checkout."
