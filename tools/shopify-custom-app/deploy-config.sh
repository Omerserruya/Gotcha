#!/usr/bin/env bash
# Deploy the official GOTCHA Shopify app's configuration to a per-merchant custom distribution app
# (2026-11-22, Omer, path A, step 3).
#
#   tools/shopify-custom-app/deploy-config.sh [--dry-run] <client_id> [app_name]
#
# Renders shopify-app/shopify.app.production.toml with this app's client_id (and an optional name) into
# a temporary config next to it (the CLI reads configs from the app directory, and the theme app extension
# under shopify-app/extensions is deployed with it), then runs
#   npx @shopify/cli@3.89.0 app deploy --config <name> --force
# and removes the temporary config. Scopes, application_url, redirect_urls, webhooks, embedded=false and
# the app proxy are exactly the official app's.
#
# --dry-run: renders the config and runs `app info --config <name>` (read-only) instead of deploying.
#
# Auth: SHOPIFY_CLI_PARTNERS_TOKEN when it is set (a Partner Dashboard CLI token; NOT our
# SHOPIFY_PARTNER_API_TOKEN); otherwise the CLI's saved session on this machine (a person who ran
# `shopify auth login` once). Without either the CLI asks to log in.
#
# Node: the CLI needs Node 20.10 or later. ~/.local/share/node22/bin is put first on PATH when it exists;
# an older node is refused with a clear message.
#
# What stays manual in the Dev Dashboard: distribution custom, the store, the install link, the IP
# allowlist. Then paste the client id, the secret and the link in the console.
set -euo pipefail

CLI_VERSION="3.89.0"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi
CLIENT_ID="${1:-}"
APP_NAME="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../../shopify-app" && pwd)"
SOURCE="$APP_DIR/shopify.app.production.toml"

if [[ ! "$CLIENT_ID" =~ ^[A-Za-z0-9_-]{8,128}$ ]]; then
  echo "usage: $0 [--dry-run] <client_id> [app_name]   (client_id: letters, digits, _ or -)" >&2
  exit 2
fi

# Node 20.10 or later: the CLI refuses older ones.
NODE22="${HOME}/.local/share/node22/bin"
if [[ -x "$NODE22/node" ]]; then export PATH="$NODE22:$PATH"; fi
if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  echo "node and npx are needed (Node 20.10 or later; expected at $NODE22)." >&2
  exit 4
fi
NODE_VERSION="$(node -p 'process.versions.node')"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=10)?0:1)'; then
  echo "Node $NODE_VERSION is too old for the Shopify CLI: Node 20.10 or later is needed (put Node 22 at $NODE22)." >&2
  exit 4
fi

if [[ -n "${SHOPIFY_CLI_PARTNERS_TOKEN:-}" ]]; then
  echo "auth: SHOPIFY_CLI_PARTNERS_TOKEN"
else
  echo "auth: the Shopify CLI's saved session on this machine (no SHOPIFY_CLI_PARTNERS_TOKEN set)"
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "missing $SOURCE" >&2
  exit 5
fi
OFFICIAL_ID="$(sed -n 's/^client_id = "\(.*\)"$/\1/p' "$SOURCE" | head -1)"
if [[ "$CLIENT_ID" == "$OFFICIAL_ID" ]]; then
  echo "refusing: $CLIENT_ID is the official app's client id." >&2
  exit 6
fi

CONFIG_NAME="custom-${CLIENT_ID:0:12}"
TARGET="$APP_DIR/shopify.app.${CONFIG_NAME}.toml"
trap 'rm -f "$TARGET"' EXIT

# Only the identity lines change: client_id, and the name when one is given.
sed -e "s/^client_id = \".*\"$/client_id = \"${CLIENT_ID}\"/" "$SOURCE" > "$TARGET"
if [[ -n "$APP_NAME" ]]; then
  ESCAPED_NAME="$(printf '%s' "$APP_NAME" | sed 's/[\/&"]/\\&/g')"
  sed -i -e "s/^name = \".*\"$/name = \"${ESCAPED_NAME}\"/" "$TARGET"
fi
if ! grep -q "^client_id = \"${CLIENT_ID}\"$" "$TARGET"; then
  echo "rendering failed: client_id not set in $TARGET" >&2
  exit 7
fi

cd "$APP_DIR"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry run: rendered $TARGET (Node $NODE_VERSION); reading the app, nothing deployed"
  npx --yes "@shopify/cli@${CLI_VERSION}" app info --config "$CONFIG_NAME"
  exit 0
fi
echo "deploying the official config to client_id ${CLIENT_ID} (config ${CONFIG_NAME}, Node $NODE_VERSION)"
npx --yes "@shopify/cli@${CLI_VERSION}" app deploy --config "$CONFIG_NAME" --force
