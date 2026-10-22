#!/usr/bin/env bash
# Does the gateway forward the SAME request URI to Authentik as it did at a
# base ref? (2026-10-22, written for the per-request resolver change.)
#
# A `proxy_pass` to a variable does no prefix replacement, so /auth-api/ now
# rewrites to /api/v3/ itself, and a rewrite works on the decoded URI. This
# script measures instead of reasoning: it renders both templates at BASE and
# in the working tree, points their Authentik at a stub that echoes the
# request URI it receives, sends percent-encoded paths and queries through
# each, and fails on any difference.
#
#   scripts/authentik/authentik-uri-parity.sh [BASE_REF]   # default a7f9cb19
#
# Needs: the dev stack up (the other upstream names must resolve on its
# network). Starts only throwaway containers, and stops them on exit.
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE="${1:-a7f9cb19}"
NET="${NET:-chatcenter_default}"
TMP="$(mktemp -d)"
NAMES=()
cleanup() { [ "${#NAMES[@]}" -gt 0 ] && docker stop "${NAMES[@]}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

W='$AUTH_PORT $CONVERSATION_PORT $WEBHOOK_PORT $ANALYTICS_PORT $CHATBOT_PORT $AI_PORT $VOICE_COPILOT_PORT $NOTIFICATIONS_PORT $BILLING_PORT $AUTHENTIK_PORT $PUBLIC_PRICING_ENABLED $TRUST_PUBLIC_URL'
ENVS=(-e AUTH_PORT=4001 -e CONVERSATION_PORT=4002 -e WEBHOOK_PORT=4003 -e ANALYTICS_PORT=4004
      -e CHATBOT_PORT=4005 -e AI_PORT=4006 -e VOICE_COPILOT_PORT=4007 -e NOTIFICATIONS_PORT=4008
      -e BILLING_PORT=4009 -e AUTHENTIK_PORT=9000 -e PUBLIC_PRICING_ENABLED=false
      -e TRUST_PUBLIC_URL=https://trust.gotcha.co.il)

printf 'events {}\nhttp { server { listen 9000; location / { default_type text/plain; return 200 "$request_uri\\n"; } } }\n' > "$TMP/stub.conf"
STUB="uri-parity-stub-$$"
docker run -d --rm --name "$STUB" --network "$NET" --network-alias "$STUB" \
  -v "$TMP/stub.conf:/etc/nginx/nginx.conf:ro" nginx:alpine >/dev/null
NAMES+=("$STUB")

# APP|uri or AUTH|uri (each template's own names). /auth-api/ is the rewritten location; the auth vhost passes raw.
CASES=(
  "APP|/auth-api/flows/executor/default-authentication-flow/?query=next%3D%252Fhome"
  "APP|/auth-api/flows/executor/a%2Fb/"
  "APP|/auth-api/core/users/?search=%D7%A9%D7%9C%D7%95%D7%9D&page=2"
  "APP|/auth-api/x%20y/z?a=1&b=%26c"
  "APP|/auth-api/flows/instances/slug%3Aodd/"
  "APP|/auth-api/%D7%A9/"
  "AUTH|/if/flow/default-authentication-flow/?next=%2Fapplication%2Fo%2Fauthorize%2F%3Fclient_id%3Dx"
  "AUTH|/application/o/a%2Fb/?x=%26"
  "AUTH|/static/dist/custom.css?v=%D7%A9"
)

run() { # $1 label, $2 template file, $3 app host, $4 auth host -> one URI per case
  local name="uri-parity-$1-$$"
  sed "s/authentik-server:\${AUTHENTIK_PORT}/$STUB:9000/g" "$2" > "$TMP/$1.template"
  docker run -d --rm --name "$name" --network "$NET" "${ENVS[@]}" \
    -v "$TMP/$1.template:/tmp/t:ro" --entrypoint sh nginx:alpine \
    -c "envsubst '$W' < /tmp/t > /etc/nginx/nginx.conf && nginx -g 'daemon off;'" >/dev/null
  NAMES+=("$name")
  sleep 3
  for c in "${CASES[@]}"; do
    local host="${c%%|*}"; [ "$host" = APP ] && host="$3"; [ "$host" = AUTH ] && host="$4"
    docker exec "$name" wget -q -O - --header "Host: $host" "http://127.0.0.1${c#*|}" || echo "(request failed)"
  done
}

fail=0
# template|app host|auth host (each template's own vhost names)
for t in "nginx/nginx.conf.template|dev.gotcha.co.il|auth-dev.gotcha.co.il" \
         "gateway/nginx.prod.conf.template|app.gotcha.co.il|auth.gotcha.co.il"; do
  IFS='|' read -r tpl app auth <<< "$t"
  git show "$BASE:$tpl" > "$TMP/base.src"
  label="$(basename "$(dirname "$tpl")")"
  run "base-$label" "$TMP/base.src" "$app" "$auth" > "$TMP/base.out"
  run "head-$label" "$tpl" "$app" "$auth" > "$TMP/head.out"
  if diff -u "$TMP/base.out" "$TMP/head.out" > "$TMP/diff"; then
    echo "OK   $tpl: ${#CASES[@]} URIs forwarded identically to $BASE"
  else
    echo "DIFF $tpl:"; cat "$TMP/diff"; fail=1
  fi
done
echo "Forwarded (prod template):"
paste -d'\t' <(printf '%s\n' "${CASES[@]}" | cut -d'|' -f2) "$TMP/head.out" | awk -F'\t' '{ printf "  %s\n      -> %s\n", $1, $2 }'
exit "$fail"
