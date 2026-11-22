#!/usr/bin/env bash
# Deploy the official GOTCHA Shopify app's configuration to a per-merchant custom distribution app
# (2026-11-22, Omer, path A, step 3).
#
#   tools/shopify-custom-app/deploy-config.sh <client_id> [app_name]
#
# Renders shopify-app/shopify.app.production.toml with this app's client_id (and an optional name) into
# a temporary config next to it (the CLI reads configs from the app directory, and the theme app extension
# under shopify-app/extensions is deployed with it), runs `shopify app deploy --config <name> --force`,
# and removes the temporary config. Scopes, application_url, redirect_urls, webhooks, embedded=false and
# the app proxy are exactly the official app's.
#
# Non-interactive auth: the Shopify CLI reads SHOPIFY_CLI_PARTNERS_TOKEN (a CLI token from the Partner
# Dashboard, Settings, CLI tokens). It is NOT our SHOPIFY_PARTNER_API_TOKEN (the Partner API token for app
# pricing checks). The script refuses to run without it.
#
# What stays manual in the Dev Dashboard after this: distribution custom, the store, the install link,
# the IP allowlist. Then paste the client id, the secret and the link in the console.
set -euo pipefail

CLIENT_ID="${1:-}"
APP_NAME="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../../shopify-app" && pwd)"
SOURCE="$APP_DIR/shopify.app.production.toml"

if [[ ! "$CLIENT_ID" =~ ^[A-Za-z0-9_-]{8,128}$ ]]; then
  echo "usage: $0 <client_id> [app_name]   (client_id: letters, digits, _ or -)" >&2
  exit 2
fi
if [[ -z "${SHOPIFY_CLI_PARTNERS_TOKEN:-}" ]]; then
  echo "SHOPIFY_CLI_PARTNERS_TOKEN is not set (a Partner Dashboard CLI token; not SHOPIFY_PARTNER_API_TOKEN)." >&2
  exit 3
fi
if ! command -v shopify >/dev/null 2>&1; then
  echo "the Shopify CLI (shopify) is not installed on this machine." >&2
  exit 4
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

echo "deploying the official config to client_id ${CLIENT_ID} (config ${CONFIG_NAME})"
cd "$APP_DIR"
shopify app deploy --config "$CONFIG_NAME" --force
