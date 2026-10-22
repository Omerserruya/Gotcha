#!/usr/bin/env bash
#
# Does every endpoint in the registry resolve to a router that declares it?
#
# ── WHY THIS EXISTS ──
# `/api/knowledge` was in the registry for a whole screen. It is allowlisted in
# the gateway, it proxies cleanly, and it answers 401 unauthenticated — so every
# check we had passed on it. It is a DIFFERENT ROUTER mounted at the same
# prefix, and it declares no `GET /`.
#
# An unauthenticated probe cannot see this. The platform services authenticate
# BEFORE they route, so a 401 does not mean the request reached a router at all:
# /api/knowledge and /api/knowledge-bases are indistinguishable from outside.
#
# This resolves the longest matching `app.use` prefix — Express's own rule —
# and then checks that THAT router declares the remaining path. It needs no
# session, no cookie and no running stack, and it found the same single defect
# an authenticated sweep found.
#
# Usage:  scripts/check-routes.sh [path-to-the-platform]
#         (default: the monorepo this app lives in)
set -uo pipefail

PLATFORM="${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
[ -d "$PLATFORM/services" ] || { echo "no services/ under $PLATFORM" >&2; exit 2; }

fail=0

resolve() {
  local path="$1" idx="$2" svc_dir="$3"
  local best_pfx="" best_router="" 
  while IFS= read -r line; do
    local rest=${line#*:}
    local pfx router
    pfx=$(sed -n 's/.*app\.use("\([^"]*\)".*/\1/p' <<<"$rest")
    router=$(sed -n 's/.*,[[:space:]]*\([A-Za-z_]*\)[[:space:]]*).*/\1/p' <<<"$rest")
    [ -n "$pfx" ] || continue
    case "$path" in
      "$pfx"|"$pfx"/*)
        if [ ${#pfx} -ge ${#best_pfx} ]; then best_pfx="$pfx"; best_router="$router"; fi ;;
    esac
  done < <(grep -n 'app\.use("/api' "$idx")

  [ -n "$best_router" ] || { printf '  %-42s NO MOUNT\n' "$path"; fail=1; return; }

  local remainder="${path#$best_pfx}"; [ -z "$remainder" ] && remainder="/"
  local rel file
  rel=$(grep -n "import $best_router" "$idx" | sed -n 's/.*from "\.\/\([^"]*\)".*/\1/p' | head -1)
  file="$svc_dir/src/$rel.ts"

  # Slurped, for the same reason `resolve_bare` is: a declaration split across
  # two lines is invisible to a line-oriented grep. This function kept the bug
  # for an hour after its sibling was fixed — one guard, two code paths, and
  # only the path that had already burned us got the repair.
  if [ -f "$file" ] && perl -0777 -ne \
       "exit(!m{router\\.(?:get|post|put|patch|delete)\\(\\s*\"\Q$remainder\E\"})" "$file"; then
    printf '  %-42s ok   %s\n' "$path" "$(basename "$rel")"
  else
    printf '  %-42s DEAD %s does not declare "%s"\n' "$path" "$(basename "${rel:-?}")" "$remainder"
    fail=1
  fi
}

# ── Routers mounted at bare /api ──────────────────────────────────────────
# These declare their own full path, so there is no remainder to check: the
# question is which router under the service declares it. EVERY billing router
# mounts this way, which is why a search for an `/api/billing` mount finds
# nothing and why `/api/billing/invoices` sat unused behind "we can't show your
# invoices yet" while it was serving four failed charges.
resolve_bare() {
  local path="$1" svc_dir="$2"
  local decl="${path#/api}"
  local hit
  # Slurped, because a route is often declared across two lines:
  #
  #     router.post(
  #       "/billing/pricing/change",
  #
  # A line-oriented grep calls both `/billing/invoices` and
  # `/billing/pricing/change` dead, and BOTH of them serve. A guard that
  # reports a false death is worse than no guard: it teaches you to skim it.
  hit=$(for f in "$svc_dir"/src/routes/*.ts; do
          perl -0777 -ne "exit(!m{router\\.(?:get|post|put|patch|delete)\\(\\s*\"\Q$decl\E\"})" "$f" \
            && { echo "$f"; break; }
        done)

  if [ -z "$hit" ]; then
    printf '  %-42s DEAD no router declares "%s"\n' "$path" "$decl"; fail=1; return
  fi

  # Declaring it is not serving it. The router must also be mounted.
  local base idx
  base=$(basename "$hit" .ts)
  idx="$svc_dir/src/index.ts"
  if grep -q "app\.use(\"/api\"" "$idx" && grep -q "$base" "$idx"; then
    printf '  %-42s ok   %s (bare /api)\n' "$path" "$base"
  else
    printf '  %-42s UNMOUNTED declared in %s\n' "$path" "$base"; fail=1
  fi
}

echo "Resolving registry endpoints against Express mounts:"
resolve /api/ai-agents                      "$PLATFORM/services/ai/src/index.ts"       "$PLATFORM/services/ai"
resolve /api/knowledge-bases                "$PLATFORM/services/ai/src/index.ts"       "$PLATFORM/services/ai"
resolve /api/tool-permissions               "$PLATFORM/services/ai/src/index.ts"       "$PLATFORM/services/ai"
resolve /api/chatbot-flows                  "$PLATFORM/services/chatbot/src/index.ts"  "$PLATFORM/services/chatbot"

AI="$PLATFORM/services/ai"
BILL="$PLATFORM/services/billing"

resolve_bare /api/knowledge/unanswered-questions  "$AI"

# Screen 17 — every billing endpoint in the registry, including the ones that
# were already there. The point of a guard is that it covers what is already
# believed to work.
resolve_bare /api/billing/subscription            "$BILL"
resolve_bare /api/billing/invoices                "$BILL"
resolve_bare /api/billing/auto-purchase           "$BILL"
resolve_bare /api/billing/profile                 "$BILL"
resolve_bare /api/billing/payment-methods         "$BILL"
resolve_bare /api/billing/credit-summary          "$BILL"

# Screen 17b — pricing, quote and change.
resolve_bare /api/billing/pricing                 "$BILL"
resolve_bare /api/billing/pricing/quote           "$BILL"
resolve_bare /api/billing/pricing/current         "$BILL"
resolve_bare /api/billing/pricing/packages        "$BILL"
resolve_bare /api/billing/pricing/change          "$BILL"
resolve_bare /api/billing/subscription/change-plan "$BILL"

# Screen 13 — WhatsApp numbers. A DIFFERENT router from /api/channels, at a
# prefix that contains it: exactly the shape that made /api/knowledge look
# alive for a whole screen.
AUTH="$PLATFORM/services/auth"
resolve /api/channels/whatsapp/numbers      "$AUTH/src/index.ts"  "$AUTH"
resolve /api/channels/whatsapp/exclusions   "$AUTH/src/index.ts"  "$AUTH"

exit $fail
