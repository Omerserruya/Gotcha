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
# Usage:  scripts/check-routes.sh [path-to-ChatCenter]
set -uo pipefail

PLATFORM="${1:-$HOME/projects/ChatCenter}"
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

  if [ -f "$file" ] && grep -qE "router\.(get|post|put|patch|delete)\(\"$remainder\"" "$file"; then
    printf '  %-42s ok   %s\n' "$path" "$(basename "$rel")"
  else
    printf '  %-42s DEAD %s does not declare "%s"\n' "$path" "$(basename "${rel:-?}")" "$remainder"
    fail=1
  fi
}

echo "Resolving registry endpoints against Express mounts:"
resolve /api/ai-agents                      "$PLATFORM/services/ai/src/index.ts"       "$PLATFORM/services/ai"
resolve /api/knowledge-bases                "$PLATFORM/services/ai/src/index.ts"       "$PLATFORM/services/ai"
resolve /api/tool-permissions               "$PLATFORM/services/ai/src/index.ts"       "$PLATFORM/services/ai"
resolve /api/chatbot-flows                  "$PLATFORM/services/chatbot/src/index.ts"  "$PLATFORM/services/chatbot"

# Routers mounted at bare /api declare their own full path, so they are checked
# against that path rather than a remainder.
if grep -q 'router.get("/knowledge/unanswered-questions"' \
     "$PLATFORM/services/ai/src/routes/unanswered-questions.ts" 2>/dev/null &&
   grep -q 'app.use("/api", unansweredQuestionRoutes)' "$PLATFORM/services/ai/src/index.ts"; then
  printf '  %-42s ok   unanswered-questions (mounted at bare /api)\n' /api/knowledge/unanswered-questions
else
  printf '  %-42s DEAD\n' /api/knowledge/unanswered-questions; fail=1
fi

exit $fail
