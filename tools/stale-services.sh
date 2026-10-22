#!/usr/bin/env bash
# Which running services are NOT running the source in this checkout.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY /health's BUILD_SHA CANNOT ANSWER THIS ON DEV
#
# Every dev service reports build:"dev", and for TWO different reasons - which
# is worth knowing, because it makes the gate even less useful than it looks:
#
#   conversation, ai, billing   receive `BUILD_SHA: ${BUILD_SHA:-dev}` and the
#                               host variable is unset, so the default fires
#   the other eight            never receive the variable at all, so the
#                               `|| "dev"` fallback in service-app.ts fires
#
# Either way the string is identical before and after any rebuild, so a gate
# comparing it would pass every time and catch nothing - a control that cannot
# fail.
#
# ★ AS OF 2026-09-27 THIS IS NO LONGER UNIFORM. The `ai` image is now built with
# the real short sha, so `/health` on `ai` answers with something that means
# something while every other service still says "dev". That asymmetry is
# deliberate and visible, which beats uniform and useless - but it means "they
# all say dev" has become a claim to re-check rather than a standing fact.
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
#
# ─────────────────────────────────────────────────────────────────────────────
# ★★ AND THE FIRST VERSION OF THIS SCRIPT NAMED A REMEDY THAT WAS THE DISEASE.
#
# It lumped `packages/shared` in with each service's own source and then
# prescribed RESTART for every mounted service. But NO service mounts
# `packages/shared` - it is a symlink to the BAKED copy inside the image. So a
# restart cannot pick up a shared change, and worse:
#
#   `ai` mounts services/ai/src, so a restart runs the CURRENT source against
#   the image's FROZEN shared. On 2026-09-27 the mounted orchestrator called
#   `describeApprovalAction` and the baked August shared did not export it.
#   CommonJS makes a missing named export `undefined` rather than a load error
#   (measured in the image), so the call threw, a catch swallowed it, and no
#   approval row was written. The script said "needs RESTART" and the restart
#   was the harmful act.
#
# So a diagnostic that answers "is the source current" when the question is
# "can this source RUN" is worse than silence, because its output is what an
# operator does next. This now asks the second question: it compares the change
# set against what each container actually MOUNTS, and reports MISMATCH when a
# mounted service's source has moved ahead of the image its dependencies live in.
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

  # The two sources are kept SEPARATE, because only one of them can be mounted.
  own_s=$(newest_change "$dir/src")
  shared_s=$(newest_change "$SHARED")
  src_s=$own_s; [ "$shared_s" -gt "$src_s" ] && src_s=$shared_s

  if [ "$kind" = mounted ]; then
    if [ "$own_s" -gt "$built_s" ] || [ "$shared_s" -gt "$built_s" ]; then
      # The mounted source, or the shared package it imports, has moved since
      # this image was built. A restart pairs current source with the image's
      # frozen packages/shared - which is how a new call reaches an old export.
      verdict="MISMATCH - needs REBUILD (a restart runs new src on the image's old shared)"
    elif [ "$own_s" -gt "$started_s" ]; then
      verdict="STALE - needs RESTART"
    else
      verdict="current"
    fi
  else
    if [ "$src_s" -gt "$built_s" ]; then
      verdict="STALE - needs REBUILD"
    else
      verdict="current"
    fi
  fi
  case "$verdict" in current) ;; *) stale=$((stale + 1)) ;; esac

  printf '%-18s %-9s %-20s %-20s %s\n' "$svc" "$kind" \
    "$(date -d "@$ref" '+%Y-%m-%d %H:%M:%S')" "$(date -d "@$src_s" '+%Y-%m-%d %H:%M:%S')" "$verdict"
done

echo
if [ "$stale" -gt 0 ]; then
  echo "$stale service(s) are not running this checkout. A capture against them verifies the OLD code."
  echo "A RESTART is cheap and reversible. A REBUILD picks up every uncommitted change in the tree"
  echo "and is a deployment decision on a shared box - ask before doing one."
  echo
  echo "MISMATCH is not ordinary staleness: the mounted source has moved ahead of the image its"
  echo "packages/shared lives in, so a RESTART would run new code against old dependencies. A"
  echo "missing named export is \`undefined\` under CommonJS, not a load error, so that failure is"
  echo "silent. Do not restart a MISMATCH service - rebuild it, and from \`git archive <ref>\`"
  echo "rather than from this tree, which two sessions edit."
  exit 1
fi
echo "Every running service matches this checkout."
