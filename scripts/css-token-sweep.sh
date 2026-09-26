#!/usr/bin/env bash
#
# Every CSS custom property used without a fallback, against every one defined.
#
# An undefined `var(--x)` with no fallback makes the whole declaration invalid
# at computed-value time — so `border: 1px solid var(--x)` is no border, and
# `background: var(--x)` is no background. Nothing fails: not the build, not
# the linter, not a test that asserts on testids and text. It is the i18n
# MISSING_MESSAGE defect one layer down, and it only shows up in a capture.
#
# `--font-*` (next/font) and `--brand-mark` (set inline in `Logo.tsx`) are
# defined from TypeScript at runtime and are listed as expected exceptions
# rather than silently skipped: a pattern that hides rows is how a sweep stops
# finding things.
set -euo pipefail
cd "$(dirname "$0")/.."

css=$(find src -name '*.css')
defined=$(grep -rhoE -- '(^|[;{[:space:]])--[a-zA-Z0-9-]+[[:space:]]*:' $css |
  grep -oE -- '--[a-zA-Z0-9-]+' | sort -u)
used=$(grep -rhoE -- 'var\(--[a-zA-Z0-9-]+\)' $css |
  grep -oE -- '--[a-zA-Z0-9-]+' | sort -u)

missing=$(comm -13 <(echo "$defined") <(echo "$used") |
  grep -vE '^--(font-(archivo|heebo|frank-ruhl-libre|ibm-plex-mono|instrument-serif)|brand-mark)$' || true)

if [ -z "$missing" ]; then
  echo "OK — every var() resolves ($(echo "$used" | wc -l) used, $(echo "$defined" | wc -l) defined)."
  exit 0
fi

echo "USED BUT NEVER DEFINED — each of these renders as nothing:"
echo
for token in $missing; do
  echo "  $token"
  grep -rn -- "var($token)" $css | sed 's/^/      /'
done
echo
echo "$(echo "$missing" | wc -l) undefined. Replace with a token from"
echo "src/design-system/tokens/tokens.css — the vocabulary there is semantic."
exit 1
