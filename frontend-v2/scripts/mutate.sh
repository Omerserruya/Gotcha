#!/usr/bin/env bash
#
# Break the code on purpose and require the tests to notice.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY THIS IS A FILE RATHER THAN SOMETHING RETYPED EACH TIME
# ═══════════════════════════════════════════════════════════════════════════
# Mutation is the only instrument in this project that has ever caught a
# fixture which could not discriminate — a test that passes whether or not the
# behaviour it names is there. Four of them in one day, none found by reading:
#
#   · hostile URLs with an EMPTY path, so a guard that threw the host away and
#     kept the path returned "safe" for every one of them
#   · a probe written from memory of a defect rather than from the code, which
#     passed while the real defect walked through
#   · a matcher read out of a source file without undoing its string escaping
#   · an assertion anchored on a function name, which matched the RETURN TYPE
#     and not the body
#
# Each was green, plausible, and wrong in the reassuring direction.
#
#   scripts/mutate.sh <source-file> <anchor-file> <replacement-file> <test…>
#
# The anchor and the replacement are FILES, not arguments. That is deliberate:
# a backtick inside a double-quoted shell string is a command substitution, and
# this repository has already had a diagnostic that executed the code it was
# meant to print. Passing them as files means neither is ever parsed by a
# shell.
#
# Exit codes are the report:
#   0  CAUGHT    — the suite reddened. The assertion is load-bearing.
#   1  SURVIVED  — the suite passed with the code broken. The test proves less
#                  than it claims, and that is a finding, not a formality.
#   2  UNKNOWN   — it could not tell. NEVER read as either of the above.
set -uo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <source-file> <anchor-file> <replacement-file> <test path…>" >&2
  exit 2
fi

SOURCE="$1"
ANCHOR_FILE="$2"
REPLACEMENT_FILE="$3"
shift 3

for required in "$SOURCE" "$ANCHOR_FILE" "$REPLACEMENT_FILE"; do
  [ -f "$required" ] || { echo "UNKNOWN — no such file: $required" >&2; exit 2; }
done

BACKUP="$(mktemp)"
cp "$SOURCE" "$BACKUP"
# Unconditional: an interrupted run must not leave the tree mutated. A green
# `npm run verify` on a file somebody forgot to restore is the worst outcome
# this script could produce.
trap 'cp "$BACKUP" "$SOURCE"; rm -f "$BACKUP"' EXIT

# ★ THE ANCHOR MUST BE UNIQUE, AND ITS ABSENCE IS NOT A PASS.
# Prettier reformats multi-line calls, so an anchor copied from source before a
# format run matches nothing afterwards — three mutations were once reported
# SKIPPED for exactly that, and a "skipped" read as "fine" would have been
# three false negatives.
if ! python3 - "$SOURCE" "$ANCHOR_FILE" "$REPLACEMENT_FILE" <<'PY'
import io, sys
source, anchor_file, replacement_file = sys.argv[1], sys.argv[2], sys.argv[3]
text = io.open(source, encoding='utf-8').read()
anchor = io.open(anchor_file, encoding='utf-8').read().rstrip('\n')
replacement = io.open(replacement_file, encoding='utf-8').read().rstrip('\n')
count = text.count(anchor)
if count != 1:
    sys.stderr.write(
        'UNKNOWN — the anchor appears %d times, not once.\n'
        'A mutation applied to the wrong site, or to none, reports nothing true.\n' % count
    )
    sys.exit(1)
io.open(source, 'w', encoding='utf-8').write(text.replace(anchor, replacement, 1))
PY
then
  exit 2
fi

OUTPUT="$(PATH="/usr/lib/code-server/lib:$PATH" npx vitest run "$@" 2>&1)"

# ★ THE WHOLE OUTPUT, NEVER `tail`. Vitest's "Tests N failed" line is not the
# last one it prints — a harness reading `tail -3` once reported seven
# mutations green in a row.
SUMMARY="$(printf '%s\n' "$OUTPUT" | grep -E '^ +Tests +[0-9]' | tail -1)"

if [ -z "$SUMMARY" ]; then
  echo "UNKNOWN — no summary line in the output. The suite did not run." >&2
  printf '%s\n' "$OUTPUT" | tail -20 >&2
  exit 2
fi

if printf '%s\n' "$SUMMARY" | grep -q 'failed'; then
  echo "CAUGHT   | $SUMMARY"
  exit 0
fi

# ⚠⚠ A FILE THAT DID NOT LOAD IS NOT A SURVIVOR. A mutation that leaves the
# source unparseable fails its test FILES, not its tests: the `Tests` line
# then counts only the files that still loaded — 157 of 250 once — and says
# "passed". That read as SURVIVED for a mutation that tested nothing.
FILES="$(printf '%s\n' "$OUTPUT" | grep -E '^ +Test Files +[0-9]' | tail -1)"
if printf '%s\n' "$FILES" | grep -q 'failed'; then
  echo "UNKNOWN  | $FILES | $SUMMARY" >&2
  echo "  A test file failed to load — most likely the mutation does not compile." >&2
  echo "  Rewrite the replacement as valid code; this run proves nothing." >&2
  exit 2
fi

echo "SURVIVED | $SUMMARY"
echo "  The code is broken and every assertion passed. Either the behaviour is"
echo "  untested, or an existing guard makes this branch unreachable — both are"
echo "  worth writing down rather than fixing by adding an assertion that only"
echo "  satisfies this run."
exit 1
