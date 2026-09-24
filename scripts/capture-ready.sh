#!/usr/bin/env bash
#
# Is the running server actually serving the build we think it is?
#
# ── WHY THIS IS A SCRIPT AND NOT A GATE YOU READ ──
# A `next start` process loads its manifests at boot and NEVER picks up a later
# rebuild. On 2026-09-24 the server on :3000 had been serving Tuesday night's
# code for NINE HOURS while `find src -newer .next/BUILD_ID` came back clean —
# because source-newer-than-build and build-newer-than-process are two
# different questions, and only the first one is a comparison between files.
#
# The failure mode that matters is not a capture that breaks. It is a capture
# that PASSES against stale code: green evidence for a screen that was never
# served. Nothing in the run says so, and the diagnostic that would have
# explained it only prints when something already failed.
#
# So this runs BEFORE a capture and refuses, rather than explaining afterwards.
#
# ── WHAT THIS DOES NOT CHECK, AND IT IS THE ONE THAT COST A DAY ──────────
#
# Four layers are covered: something is listening, the build is not newer than
# the server, no source is newer than the build, and the gateway reaches the
# services. **None of them says the services are the RIGHT BUILD.**
#
# On 2026-09-24 ten of eleven backend services ran August images while our
# contracts described that day's API. This script would have printed READY
# through the whole six hours — correctly, because every layer it can see was
# fine. The failure was one layer further out again.
#
# A `/health` build-sha gate would not have caught it either: `BUILD_SHA` is
# the literal string `dev` on every dev service, so it matches itself.
#
# The instrument for that layer is the platform's own `tools/stale-services.sh`,
# which compares running containers against the checkout. So the pre-capture
# sequence is TWO commands, not one:
#
#   tools/stale-services.sh        # are the services the code we think?
#   scripts/capture-ready.sh       # is the frontend, and can it reach them?
#
# Stated here rather than left implied, because a gate that prints READY is
# read as "everything is ready" — and the scope of a green result is exactly
# the thing nobody re-derives.
#
# Usage:  scripts/capture-ready.sh [port]
set -uo pipefail

PORT="${1:-3000}"
BUILD_ID=".next/BUILD_ID"

[ -f "$BUILD_ID" ] || { echo "no $BUILD_ID — run a build first" >&2; exit 2; }

# The pid that is LISTENING, not one matching a name. This machine also runs
# the platform's own next-server, and a `next build` leaves workers in this
# very directory that have already exited — both return a plausible answer for
# a process that is not serving the page.
pid=$(ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $0}' \
      | grep -oP 'pid=\K[0-9]+' | head -1)

if [ -z "$pid" ]; then
  echo "NOT READY  nothing is listening on :$PORT" >&2
  exit 1
fi

build_epoch=$(stat -c %Y "$BUILD_ID")
start_epoch=$(date -d "$(ps -o lstart= -p "$pid")" +%s 2>/dev/null) || {
  echo "NOT READY  could not read the start time of pid $pid" >&2; exit 1; }

printf 'build   %s\n' "$(date -d "@$build_epoch" '+%F %T')"
printf 'server  %s  (pid %s)\n' "$(date -d "@$start_epoch" '+%F %T')" "$pid"

if [ "$build_epoch" -gt "$start_epoch" ]; then
  echo "NOT READY  the build is NEWER than the server — it is serving the previous one." >&2
  echo "           restart next start, keeping E2E_SECURITY_FIXTURES=1." >&2
  exit 1
fi

# The other direction, which the existing gate already covers — kept here so
# one command answers the whole question rather than two thirds of it.
newer=$(find src e2e -newer "$BUILD_ID" -name '*.ts*' 2>/dev/null | head -3)
if [ -n "$newer" ]; then
  echo "NOT READY  source is newer than the build:" >&2
  echo "$newer" | sed 's/^/           /' >&2
  exit 1
fi

# ── AND THE LAYER THE OTHER TWO CHECKS CANNOT SEE: THE GATEWAY ────────────
#
# 2026-09-24, after the first honest deploy of the day: a capture failed 72/72
# with "the customers could not be read", which reads as a total product
# failure. It was not.
#
#   502  POST /api/contacts/segment
#   502  GET  /api/permissions/me
#
# `docker compose up -d` recreated every service container with new IPs and
# did NOT recreate the gateway — "Up About an hour" while everything behind it
# was seconds old. nginx resolves its upstreams at config load, so it was
# still addressing containers that no longer existed.
#
# ★ THE ONE-COMMAND TELL, AND IT NEEDS NO SESSION:
#
#   401  the request REACHED the service and was refused for lack of auth
#   502  it never got there
#
# An unauthenticated probe distinguishes them perfectly, costs no cookie —
# `gotcha_session` rotates on every BFF request, so a probe that carried one
# would spend it — and answers the question the other two checks structurally
# cannot. They compare artefacts on this machine; this one asks whether the
# thing in effect one layer out is the thing we think.
#
# Same family as the build-versus-process check: what is on disk is not what
# is running, one layer further out.
API_BASE="$(sed -n 's/^API_BASE_URL=//p' .env.local 2>/dev/null | tail -1)"
API_BASE="${API_BASE:-http://localhost}"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API_BASE/api/permissions/me" 2>/dev/null)

case "$code" in
  502|503|504)
    echo "NOT READY  the gateway answers $code — it is not reaching the services." >&2
    # Single quotes: backticks inside a double-quoted echo are COMMAND
    # SUBSTITUTION, and this line would have run `docker compose up -d` on the
    # failure path — a deploy action fired by a diagnostic.
    echo '           docker compose up -d recreates service containers with new IPs and' >&2
    echo "           leaves the gateway addressing the old ones. Every screen will read as" >&2
    echo "           broken and none of them is." >&2
    echo "             docker compose restart gateway" >&2
    echo "             curl -o /dev/null -w '%{http_code}' $API_BASE/api/permissions/me" >&2
    echo "           401 means it reached the service. 502 means it did not." >&2
    exit 1 ;;
  000)
    echo "NOT READY  nothing answered at $API_BASE — the platform is not up." >&2
    exit 1 ;;
esac

echo "READY      the server booted after the build, nothing is newer than it,"
echo "           and the gateway reaches the services (HTTP $code)."
