#!/usr/bin/env bash
# Build and push every service to Docker Hub as a tag inside a single repo.
#
# Convention:
#   docker.io/<user>/gotcha:<service>-<sha>     (immutable)
#   docker.io/<user>/gotcha:<service>-latest    (rolling pointer)
#
# Required env:
#   REGISTRY   e.g. docker.io/omerserruya   (no trailing slash)
#   REPO       defaults to "gotcha"
#   TAG        defaults to short git SHA
#   PLATFORM   defaults to linux/amd64 (use linux/arm64,linux/amd64 for multi-arch)
#
# Frontend env (only when publishing `gateway` or `frontend`):
#   NEXT_PUBLIC_API_URL, NEXT_PUBLIC_WS_URL,
#   NEXT_PUBLIC_META_APP_ID, NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID
#   → baked into the static bundle by the host `npm run build` step below.
#     Export them in your shell, or source .env before invoking the script.
#
# Opt-outs:
#   SKIP_FRONTEND_BUILD=1   reuse an existing frontend/out (e.g. CI artifact)
#
# Usage:
#   ./scripts/docker-publish.sh                 # build + push everything
#   SERVICES=auth,ai ./scripts/docker-publish.sh   # subset

set -euo pipefail

: "${REGISTRY:?REGISTRY required, e.g. docker.io/omerts}"
REPO="${REPO:-gotcha}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"
PLATFORM="${PLATFORM:-linux/amd64}"

# Backend services: <name>=<Dockerfile path relative to repo root>
declare -A BACKEND=(
  [auth]=services/auth/Dockerfile
  [conversation]=services/conversation/Dockerfile
  [webhook]=services/webhook/Dockerfile
  [analytics]=services/analytics/Dockerfile
  [chatbot]=services/chatbot/Dockerfile
  [ai]=services/ai/Dockerfile
  [voice-copilot]=services/voice-copilot/Dockerfile
  [notifications]=services/notifications/Dockerfile
  [incoming-worker]=services/incoming-worker/Dockerfile
  [outgoing-worker]=services/outgoing-worker/Dockerfile
)

# Optional filter
if [ -n "${SERVICES:-}" ]; then
  IFS=',' read -ra WANTED <<< "$SERVICES"
  declare -A FILTERED=()
  for s in "${WANTED[@]}"; do
    if [ -n "${BACKEND[$s]:-}" ]; then
      FILTERED[$s]="${BACKEND[$s]}"
    fi
  done
  BACKEND=()
  for k in "${!FILTERED[@]}"; do BACKEND[$k]="${FILTERED[$k]}"; done
fi

echo "Registry : $REGISTRY"
echo "Repo     : $REPO"
echo "Tag      : $TAG"
echo "Platform : $PLATFORM"
echo "Services : ${!BACKEND[*]} $( [ -z "${SERVICES:-}" ] && echo gateway )"
echo

# Ensure a buildx builder exists.
docker buildx inspect chatcenter-builder >/dev/null 2>&1 || \
  docker buildx create --name chatcenter-builder --use

push_image() {
  local svc="$1"
  local dockerfile="$2"
  local context="$3"
  shift 3
  echo "── $svc ─────────────────────────────────────────"
  docker buildx build \
    --platform "$PLATFORM" \
    -f "$dockerfile" \
    -t "$REGISTRY/$REPO:${svc}-${TAG}" \
    -t "$REGISTRY/$REPO:${svc}-latest" \
    --push \
    "$@" \
    "$context"
}

# Backend
for svc in "${!BACKEND[@]}"; do
  push_image "$svc" "${BACKEND[$svc]}" "."
done

# Gateway = API reverse-proxy + Next.js static export, merged into one nginx
# image (gateway/Dockerfile.prod). Build context is the repo root because the
# Dockerfile pulls from both frontend/ and gateway/.
#
# The static export is built on the HOST (`npm run build` below) instead of
# inside Docker. Cross-arch buildx (amd64 host → arm64 target) emulates the
# Node builder under QEMU, and QEMU networking can't reach fonts.gstatic.com
# — `next/font/google` hangs and times out after ~30 min. Static files are
# arch-independent, so building on the host and copying into an arm64
# nginx:alpine works fine.
#
# The legacy SERVICES=frontend filter is honoured so existing CI invocations
# don't break — the canonical name is now `gateway`.
if [ -z "${SERVICES:-}" ] || [[ ",$SERVICES," == *,gateway,* ]] || [[ ",$SERVICES," == *,frontend,* ]]; then
  if [ "${SKIP_FRONTEND_BUILD:-0}" != "1" ]; then
    echo "── frontend static export (host build) ──────────"
    # NEXT_PUBLIC_* are frozen into the static bundle at build time. The gateway
    # image is ALWAYS a production artifact (dev runs Next.js from
    # docker-compose.yml), so source prod values from an env file by default
    # instead of trusting whatever happens to be in the ambient shell — baking
    # dev URLs into the prod bundle here causes CORS failures in prod.
    # Override with FRONTEND_ENV=<file>, or FRONTEND_ENV= to skip sourcing.
    # Load ONLY NEXT_PUBLIC_* assignments — never `source` the file: it holds
    # secrets with spaces (e.g. SMTP_PASS app-passwords) that the shell would
    # try to execute, and `set -e` would abort the build.
    FRONTEND_ENV="${FRONTEND_ENV-.env.prod}"
    if [ -n "$FRONTEND_ENV" ]; then
      if [ -f "$FRONTEND_ENV" ]; then
        echo "   loading NEXT_PUBLIC_* from: $FRONTEND_ENV"
        while IFS= read -r _line || [ -n "$_line" ]; do
          case "$_line" in
            NEXT_PUBLIC_*=*) export "${_line%%=*}=${_line#*=}" ;;
          esac
        done < "$FRONTEND_ENV"
      else
        echo "   WARNING: FRONTEND_ENV='$FRONTEND_ENV' not found — using ambient shell vars" >&2
      fi
    fi
    : "${NEXT_PUBLIC_API_URL:?NEXT_PUBLIC_API_URL is empty — refusing to bake a frontend with no API URL (set it in $FRONTEND_ENV or the shell)}"
    echo "   NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}"
    (
      cd frontend
      [ -d node_modules ] || npm install
      NEXT_TELEMETRY_DISABLED=1 \
      NEXT_OUTPUT=export \
      NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-}" \
      NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL:-}" \
      NEXT_PUBLIC_META_APP_ID="${NEXT_PUBLIC_META_APP_ID:-}" \
      NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID="${NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID:-}" \
        npm run build
    )
  fi
  if [ ! -d frontend/out ]; then
    echo "ERROR: frontend/out is missing after build step."
    echo "       If you set SKIP_FRONTEND_BUILD=1, supply a prebuilt frontend/out."
    exit 1
  fi
  push_image gateway gateway/Dockerfile.prod .
fi

echo
echo "Done. Pushed tag suffix: ${TAG}"
echo "Deploy with:"
echo "  REGISTRY=$REGISTRY TAG=$TAG docker compose -f docker-compose.prod.yml pull"
echo "  REGISTRY=$REGISTRY TAG=$TAG docker compose -f docker-compose.prod.yml up -d"
