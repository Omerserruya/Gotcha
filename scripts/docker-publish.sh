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
# The app (frontend-v2) image, built when SERVICES is unset or names
# `frontend-v2`. Its NEXT_PUBLIC_* values are frozen in at build:
#   V2_REALTIME_URL   defaults to https://app.gotcha.co.il
#   V2_SENTRY_DSN     optional (the browser's Sentry DSN)
#   base path ""      (the app is the whole site), APP_ENV production,
#                     RELEASE = TAG
# The legacy frontend/ is code only since 2026-10-21: nothing here builds it.
#
# Opt-outs:
#   SKIP_LANDING_BUILD=1    reuse an existing landing/out
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
echo "Services : ${!BACKEND[*]} $( [ -z "${SERVICES:-}" ] && echo frontend-v2 gateway )"
echo

# Use a builder with bounded memory and build parallelism.
GOTCHA_BUILDKIT_CONFIG="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/buildkitd.toml"

docker buildx inspect chatcenter-builder >/dev/null 2>&1 || \
  docker buildx create \
    --name chatcenter-builder \
    --driver docker-container \
    --driver-opt memory=3g,memory-swap=4g,network=bridge \
    --buildkitd-config "$GOTCHA_BUILDKIT_CONFIG" \
    --buildkitd-flags '--allow-insecure-entitlement=network.host' \
    --use

export BUILDX_BUILDER=chatcenter-builder

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

# The app (frontend-v2): a Node image of its own, proxied by the gateway at the
# root. Built inside Docker (its fonts are self-hosted, so the build needs no
# network under QEMU). Every NEXT_PUBLIC_* is a build arg: a runtime value
# never reaches the browser bundle.
if [ -z "${SERVICES:-}" ] || [[ ",$SERVICES," == *,frontend-v2,* ]]; then
  v2_args=(
    --build-arg "NEXT_PUBLIC_BASE_PATH="
    --build-arg "NEXT_PUBLIC_APP_ENV=production"
    --build-arg "NEXT_PUBLIC_REALTIME_URL=${V2_REALTIME_URL:-https://app.gotcha.co.il}"
    --build-arg "NEXT_PUBLIC_RELEASE=${TAG}"
  )
  # Optional: an ARG passed empty is SET, and the app's schema rejects ''.
  if [ -n "${V2_SENTRY_DSN:-}" ]; then v2_args+=(--build-arg "NEXT_PUBLIC_SENTRY_DSN=${V2_SENTRY_DSN}"); fi
  push_image frontend-v2 frontend-v2/Dockerfile frontend-v2 "${v2_args[@]}"
fi

# Gateway = API reverse-proxy + the static marketing sites + the widget, in one
# nginx image (gateway/Dockerfile.prod); build context is the repo root. The
# application is no longer in it (frontend-v2, above). The marketing export is
# built on the HOST: cross-arch buildx emulates Node under QEMU, which cannot
# reach fonts.gstatic.com, and static files are arch-independent.
#
# The legacy SERVICES=frontend filter is honoured so existing CI invocations
# don't break - the canonical name is now `gateway`.
if [ -z "${SERVICES:-}" ] || [[ ",$SERVICES," == *,gateway,* ]] || [[ ",$SERVICES," == *,frontend,* ]]; then
  # The marketing site is the gateway's static root for gotcha.co.il, trust.
  # and help. Built on the host: static files are arch-independent, and
  # cross-arch buildx cannot reach Google Fonts under QEMU.
  #
  # It takes no NEXT_PUBLIC_* URLs. Every cross-section link resolves to a plain
  # path unless a hostname is configured, and in production all three names are
  # served by this one image, so a path is already the right answer.
  if [ "${SKIP_LANDING_BUILD:-0}" != "1" ]; then
    echo "── marketing static export (host build) ─────────"
    (
      cd landing
      [ -d node_modules ] || npm ci
      NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=export npm run build
    )
  fi
  if [ ! -d landing/out ]; then
    echo "ERROR: landing/out is missing after build step."
    echo "       If you set SKIP_LANDING_BUILD=1, supply a prebuilt landing/out."
    exit 1
  fi

  # Campaign landings: the gateway's third static root, go.gotcha.co.il.
  #
  # Unlike the marketing site this one DOES care about NEXT_PUBLIC_* URLs, and
  # they are inlined here at build time. go.gotcha.co.il is a separate hostname
  # with no /login and no /pricing of its own, so every link out of a campaign
  # page has to be absolute; campaigns/src/lib/site.ts defaults them to the
  # production hostnames, and the variables below only need setting to point a
  # build somewhere else (staging, or a local run).
  if [ "${SKIP_CAMPAIGNS_BUILD:-0}" != "1" ]; then
    echo "── campaign static export (host build) ──────────"
    (
      cd campaigns
      [ -d node_modules ] || npm ci
      NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=export npm run build
    )
  fi
  if [ ! -d campaigns/out ]; then
    echo "ERROR: campaigns/out is missing after build step."
    echo "       If you set SKIP_CAMPAIGNS_BUILD=1, supply a prebuilt campaigns/out."
    exit 1
  fi

  # The widget is COPYed into the gateway image as committed; refuse to ship
  # one that is not the current build of its source.
  node scripts/widget/build-widget.mjs --check || { echo "ERROR: frontend/public/widget is not the current build (run node scripts/widget/build-widget.mjs)."; exit 1; }

  push_image gateway gateway/Dockerfile.prod .
fi

echo
echo "Done. Pushed tag suffix: ${TAG}"
echo "Deploy with:"
echo "  REGISTRY=$REGISTRY TAG=$TAG docker compose -f docker-compose.prod.yml pull"
echo "  REGISTRY=$REGISTRY TAG=$TAG docker compose -f docker-compose.prod.yml up -d"
