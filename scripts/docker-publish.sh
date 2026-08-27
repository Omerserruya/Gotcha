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
#   NEXT_PUBLIC_META_APP_ID, NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
#   NEXT_PUBLIC_OIDC_ISSUER, NEXT_PUBLIC_OIDC_CLIENT_ID,
#   NEXT_PUBLIC_OIDC_REDIRECT_URI
#   → baked into the static bundle by the host `npm run build` step below.
#     Export them in your shell, or source .env before invoking the script.
#     NEXT_PUBLIC_API_URL / _OIDC_ISSUER / _OIDC_REDIRECT_URI are REQUIRED: a
#     bundle missing them ships with no way to reach the API or to log in, so
#     the build fails fast rather than producing a broken artifact. Changing
#     any of them requires a rebuild - they are frozen at build time, never
#     read at runtime.
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
  [billing]=services/billing/Dockerfile
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
echo "Latest   : $( [ "${PUSH_LATEST:-1}" = "1" ] && echo "yes (rolling tag moves - this deploys)" || echo "no (SHA tag only - production unchanged)" )"
echo "Services : ${!BACKEND[*]} $( [ -z "${SERVICES:-}" ] && echo gateway )"
echo

# Ensure a buildx builder exists.
docker buildx inspect chatcenter-builder >/dev/null 2>&1 || \
  docker buildx create --name chatcenter-builder --use

# Publishing `<service>-latest` IS a deploy, not a preparation for one.
# Production pins TAG=latest (see .env.prod, which push-deploy.sh lands on the
# box as .env), so the moment a rolling tag moves, the next container restart
# picks it up - no deliberate step in between. PUSH_LATEST=0 builds and pushes
# only the immutable SHA tag, so images can be staged in the registry while
# production keeps serving exactly what it serves today. Defaults to 1 so
# existing CI invocations are unchanged.
PUSH_LATEST="${PUSH_LATEST:-1}"

push_image() {
  local svc="$1"
  local dockerfile="$2"
  local context="$3"
  shift 3
  echo "── $svc ─────────────────────────────────────────"
  local tags=(-t "$REGISTRY/$REPO:${svc}-${TAG}")
  if [ "$PUSH_LATEST" = "1" ]; then
    tags+=(-t "$REGISTRY/$REPO:${svc}-latest")
  fi
  docker buildx build \
    --platform "$PLATFORM" \
    -f "$dockerfile" \
    "${tags[@]}" \
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
# - `next/font/google` hangs and times out after ~30 min. Static files are
# arch-independent, so building on the host and copying into an arm64
# nginx:alpine works fine.
#
# The legacy SERVICES=frontend filter is honoured so existing CI invocations
# don't break - the canonical name is now `gateway`.
if [ -z "${SERVICES:-}" ] || [[ ",$SERVICES," == *,gateway,* ]] || [[ ",$SERVICES," == *,frontend,* ]]; then
  if [ "${SKIP_FRONTEND_BUILD:-0}" != "1" ]; then
    echo "── frontend static export (host build) ──────────"
    # NEXT_PUBLIC_* are frozen into the static bundle at build time. The gateway
    # image is ALWAYS a production artifact (dev runs Next.js from
    # docker-compose.yml), so source prod values from an env file by default
    # instead of trusting whatever happens to be in the ambient shell - baking
    # dev URLs into the prod bundle here causes CORS failures in prod.
    # Override with FRONTEND_ENV=<file>, or FRONTEND_ENV= to skip sourcing.
    # Load ONLY NEXT_PUBLIC_* assignments - never `source` the file: it holds
    # secrets with spaces (e.g. SMTP_PASS app-passwords) that the shell would
    # try to execute, and `set -e` would abort the build.
    FRONTEND_ENV="${FRONTEND_ENV-.env.prod}"
    if [ -n "$FRONTEND_ENV" ]; then
      if [ -f "$FRONTEND_ENV" ]; then
        echo "   loading NEXT_PUBLIC_* from: $FRONTEND_ENV"
        # The non-prefixed twins are loaded too, and that is not a convenience.
        # Several NEXT_PUBLIC_* values fall back to one (PRICING_ENABLED to
        # PUBLIC_PRICING_ENABLED, the social URLs to SOCIAL_*_URL) exactly as
        # docker-compose.yml wires them, so one value in .env drives both
        # environments. Loading only the prefixed lines made every one of those
        # fallbacks unreachable: the twin was never in the environment, so the
        # default fired and the bundle was baked with "false" while .env.prod
        # plainly said true. Silent, and invisible until someone asks why the
        # pricing page is missing.
        while IFS= read -r _line || [ -n "$_line" ]; do
          case "$_line" in
            NEXT_PUBLIC_*=*) export "${_line%%=*}=${_line#*=}" ;;
            PUBLIC_PRICING_ENABLED=*|MARKETING_URL=*|SOCIAL_INSTAGRAM_URL=*|SOCIAL_FACEBOOK_URL=*|SOCIAL_WHATSAPP_URL=*)
              export "${_line%%=*}=${_line#*=}" ;;
            # Sentry. SENTRY_FRONTEND_DSN becomes NEXT_PUBLIC_SENTRY_DSN below.
            # SENTRY_AUTH_TOKEN and SENTRY_ORG are build-time only - they gate
            # source-map UPLOAD in next.config.js and are never baked into the
            # bundle, so they are loaded but never echoed.
            SENTRY_FRONTEND_DSN=*|SENTRY_ENVIRONMENT=*|SENTRY_RELEASE=*|SENTRY_TRACES_SAMPLE_RATE=*|SENTRY_AUTH_TOKEN=*|SENTRY_ORG=*)
              export "${_line%%=*}=${_line#*=}" ;;
          esac
        done < "$FRONTEND_ENV"
      else
        echo "   WARNING: FRONTEND_ENV='$FRONTEND_ENV' not found - using ambient shell vars" >&2
      fi
    fi
    : "${NEXT_PUBLIC_API_URL:?NEXT_PUBLIC_API_URL is empty - refusing to bake a frontend with no API URL (set it in $FRONTEND_ENV or the shell)}"
    # Same reasoning as the API URL guard: the OIDC issuer is frozen into the
    # bundle, and a bundle without it cannot start a login at all - the app
    # would ship with no way in. Fail the build instead of shipping that.
    : "${NEXT_PUBLIC_OIDC_ISSUER:?NEXT_PUBLIC_OIDC_ISSUER is empty - refusing to bake a frontend that cannot log in (set it in $FRONTEND_ENV or the shell, e.g. https://auth.gotcha.co.il/application/o/gotcha/)}"
    : "${NEXT_PUBLIC_OIDC_REDIRECT_URI:?NEXT_PUBLIC_OIDC_REDIRECT_URI is empty - refusing to bake a frontend with no OAuth callback (it must also be registered in the Authentik redirect allow-list)}"
    echo "   NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}"
    echo "   NEXT_PUBLIC_OIDC_ISSUER=${NEXT_PUBLIC_OIDC_ISSUER}"
    echo "   NEXT_PUBLIC_OIDC_REDIRECT_URI=${NEXT_PUBLIC_OIDC_REDIRECT_URI}"
    # Echoed because it is invisible otherwise: NEXT_PUBLIC_* are frozen into
    # the bundle, so a wrong value here cannot be corrected by editing .env on
    # the box. The pricing flag in particular has TWO gates - this one and the
    # nginx /pricing route - and only this one requires a rebuild, which makes
    # a silent mismatch easy to chase in the wrong place.
    echo "   NEXT_PUBLIC_PRICING_ENABLED=${NEXT_PUBLIC_PRICING_ENABLED:-${PUBLIC_PRICING_ENABLED:-false}}"
    echo "   NEXT_PUBLIC_VOICE_URL=${NEXT_PUBLIC_VOICE_URL:-<default>}"
    # Decides whether `/` renders marketing or bounces a logged-out visitor to
    # /login. Empty means "single host, landing page stays at /", which is the
    # dev behaviour - so an accidental omission here silently un-splits the two
    # production hostnames rather than failing the build.
    echo "   NEXT_PUBLIC_MARKETING_URL=${NEXT_PUBLIC_MARKETING_URL:-${MARKETING_URL:-<unset - no host split>}}"
    # Echoed as present/absent only - a DSN is not a secret, but there is no
    # reason to print it into CI logs either. The browser SDK additionally
    # requires NEXT_PUBLIC_SENTRY_ENVIRONMENT=production at runtime, so a bundle
    # built without it stays silent even if a DSN was baked in.
    echo "   NEXT_PUBLIC_SENTRY_DSN=$( [ -n "${SENTRY_FRONTEND_DSN:-}" ] && echo "<set>" || echo "<unset - frontend Sentry off>" )"
    echo "   NEXT_PUBLIC_SENTRY_ENVIRONMENT=${SENTRY_ENVIRONMENT:-<unset>}"
    echo "   sourcemap upload=$( [ -n "${SENTRY_AUTH_TOKEN:-}" ] && [ -n "${SENTRY_ORG:-}" ] && [ -n "${SENTRY_RELEASE:-}" ] && [ "${SENTRY_ENVIRONMENT:-}" = "production" ] && echo "yes (explicit production release)" || echo "no" )"
    (
      cd frontend
      [ -d node_modules ] || npm install
      NEXT_TELEMETRY_DISABLED=1 \
      NEXT_OUTPUT=export \
      NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-}" \
      NEXT_PUBLIC_WS_URL="${NEXT_PUBLIC_WS_URL:-}" \
      NEXT_PUBLIC_META_APP_ID="${NEXT_PUBLIC_META_APP_ID:-}" \
      NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID="${NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID:-}" \
      NEXT_PUBLIC_OIDC_ISSUER="${NEXT_PUBLIC_OIDC_ISSUER:-}" \
      NEXT_PUBLIC_OIDC_CLIENT_ID="${NEXT_PUBLIC_OIDC_CLIENT_ID:-gotcha-app}" \
      NEXT_PUBLIC_OIDC_REDIRECT_URI="${NEXT_PUBLIC_OIDC_REDIRECT_URI:-}" \
      NEXT_PUBLIC_VOICE_URL="${NEXT_PUBLIC_VOICE_URL:-}" \
      NEXT_PUBLIC_PRICING_ENABLED="${NEXT_PUBLIC_PRICING_ENABLED:-${PUBLIC_PRICING_ENABLED:-false}}" \
      NEXT_PUBLIC_MARKETING_URL="${NEXT_PUBLIC_MARKETING_URL:-${MARKETING_URL:-}}" \
      NEXT_PUBLIC_SENTRY_DSN="${SENTRY_FRONTEND_DSN:-}" \
      NEXT_PUBLIC_SENTRY_ENVIRONMENT="${SENTRY_ENVIRONMENT:-}" \
      NEXT_PUBLIC_SENTRY_RELEASE="${SENTRY_RELEASE:-}" \
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE="${SENTRY_TRACES_SAMPLE_RATE:-0.1}" \
      NEXT_PUBLIC_SOCIAL_INSTAGRAM_URL="${NEXT_PUBLIC_SOCIAL_INSTAGRAM_URL:-${SOCIAL_INSTAGRAM_URL:-}}" \
      NEXT_PUBLIC_SOCIAL_FACEBOOK_URL="${NEXT_PUBLIC_SOCIAL_FACEBOOK_URL:-${SOCIAL_FACEBOOK_URL:-}}" \
      NEXT_PUBLIC_SOCIAL_WHATSAPP_URL="${NEXT_PUBLIC_SOCIAL_WHATSAPP_URL:-${SOCIAL_WHATSAPP_URL:-}}" \
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
