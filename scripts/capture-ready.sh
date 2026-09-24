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

echo "READY      the server booted after the build, and nothing is newer than it."
