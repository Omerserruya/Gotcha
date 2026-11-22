#!/usr/bin/env bash
# Source-flow check: where the address Authentik sends the browser to after
# "Sign in with Google" goes, against a local nginx.
#
#   scripts/gateway/check-source-flow.sh          # the prod template
#   scripts/gateway/check-source-flow.sh dev      # the dev template
#
# The rule under test: on the AUTH host,
#   /if/flow/default-source-authentication/?<args>
# answers 302 to https://<product host>/sign-in?flow=default-source-authentication&<args>,
# the args byte for byte. Only that slug. Every other /if/flow/ address stays
# Authentik's, and the recover and lost-sign-out redirects are as they were.
#
# It renders the WHOLE template the way the gateway does (the same envsubst
# list) and starts it in a throwaway nginx container on 127.0.0.1. No upstream
# runs, so an address that is handed to Authentik answers 502 here with no
# Location: that is what "stays Authentik's" looks like in this check.
#
# The template reaches Authentik by name through Docker's own DNS (127.0.0.11),
# which only a user-defined network has. So the container runs on a throwaway
# network of its own, where the name authentik-server is the container itself:
# the name resolves at once and nothing listens on the port. On the default
# bridge every such request would wait 30 seconds for a resolver that is not
# there.
#
# Nothing is built, nothing is written outside a temp folder, and the container
# and its network are removed on exit. Exit code 0 only when every check passes.
#
# Needs docker, curl and the nginx image the gateway is built on.
set -euo pipefail

MODE="${1:-prod}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${NGINX_IMAGE:-nginx:alpine}"
PORT="${CHECK_PORT:-18932}"
NAME="source-flow-check-$$"
SLUG="default-source-authentication"

case "$MODE" in
  prod)
    TEMPLATE="$ROOT/gateway/nginx.prod.conf.template"
    AUTH="auth.gotcha.co.il"; APP="app.gotcha.co.il"
    ENVSUBST="$(grep -o "envsubst '[^']*'" "$ROOT/gateway/Dockerfile.prod" | tail -1)"
    ;;
  dev)
    TEMPLATE="$ROOT/nginx/nginx.conf.template"
    AUTH="auth-dev.gotcha.co.il"; APP="dev.gotcha.co.il"
    ENVSUBST="$(grep -o "envsubst '[^']*'" "$ROOT/docker-compose.yml" | head -1 | sed 's/\$\$/$/g')"
    ;;
  *) echo "usage: $0 [prod|dev]" >&2; exit 2 ;;
esac
[ -n "$ENVSUBST" ] || { echo "STOP: no envsubst list found for $MODE" >&2; exit 2; }

WORK="$(mktemp -d /tmp/source-flow-check.XXXXXX)"
cleanup() {
  docker stop "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
  case "$WORK" in /tmp/source-flow-check.*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT
mkdir -p "$WORK/out"

# ── The gateway, whole template, upstream names pointed at nothing ──
HOSTS=()
for h in $(grep -oE '^\s*server\s+[a-z0-9-]+:' "$TEMPLATE" | awk '{print $2}' | tr -d ':' | sort -u); do
  HOSTS+=(--add-host "$h:127.0.0.1")
done

docker network create "$NAME" >/dev/null
docker run -d --rm --name "$NAME" --network "$NAME" --network-alias authentik-server \
  -p "127.0.0.1:$PORT:80" "${HOSTS[@]}" \
  -v "$TEMPLATE:/etc/nginx/nginx.conf.template:ro" \
  -e AUTH_PORT=4001 -e CONVERSATION_PORT=4002 -e WEBHOOK_PORT=4003 -e ANALYTICS_PORT=4004 \
  -e CHATBOT_PORT=4005 -e AI_PORT=4006 -e VOICE_COPILOT_PORT=4007 -e NOTIFICATIONS_PORT=4008 \
  -e BILLING_PORT=4009 -e AUTHENTIK_PORT=9000 -e FRONTEND_PORT=3000 \
  -e PUBLIC_PRICING_ENABLED=false -e TRUST_PUBLIC_URL= \
  "$IMAGE" sh -c "$ENVSUBST < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && nginx -t && nginx -g 'daemon off;'" >/dev/null

up=0
for _ in $(seq 1 40); do
  if curl -s -o /dev/null -H "Host: $APP" "http://127.0.0.1:$PORT/health"; then up=1; break; fi
  sleep 0.25
done
if [ "$up" != 1 ]; then
  echo "STOP: nginx did not start. Its log:"; docker logs "$NAME" 2>&1 | tail -20; exit 1
fi
echo "nginx: $(docker exec "$NAME" nginx -v 2>&1) | template: ${TEMPLATE#"$ROOT"/} | auth host: $AUTH | product host: $APP"

# ── Asking ─────────────────────────────────────────────────
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok    $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }
# get <path> [host]: status in $CODE, the Location header in $LOC. The path goes as written.
get() {
  CODE="$(curl -s -m 10 --path-as-is -o /dev/null -D "$WORK/out/h" -w '%{http_code}' -H "Host: ${2:-$AUTH}" "http://127.0.0.1:$PORT$1")"
  LOC="$({ grep -i '^Location:' "$WORK/out/h" || true; } | tail -1 | sed 's/^[^:]*: *//' | tr -d '\r')"
}
# goes <path> <exact location> <what> [host]
goes() {
  get "$1" "${4:-$AUTH}"
  [ "$CODE" = 302 ] && [ "$LOC" = "$2" ] && ok "302  $3 ($1)" \
    || { bad "$3 ($1): $CODE"; echo "      want: $2"; echo "      got:  $LOC"; }
}
# stays <path> <what>: handed to Authentik (502 here: nothing listens), no redirect at all.
stays() {
  get "$1"
  [ "$CODE" = 502 ] && [ -z "$LOC" ] && ok "502  stays Authentik's: $2 ($1)" || bad "$2 ($1): $CODE location=[$LOC]"
}

TO="https://$APP/sign-in?flow=$SLUG"

echo "--- the source flow's address goes to the app's sign-in screen, args untouched"
A='state=AbC-123_x.y&iss=https%3A%2F%2Faccounts.google.com&code=4%2F0Ab_xYz-12&scope=email+profile+openid+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email&authuser=0&prompt=consent'
goes "/if/flow/$SLUG/?$A" "$TO&$A" "Google's own callback args"
A='next=%2Fapplication%2Fo%2Fauthorize%2F%3Fclient_id%3Dgotcha%26state%3Dq%252B1%26redirect_uri%3Dhttps%253A%252F%252Fapp.example%252Fcb'
goes "/if/flow/$SLUG/?$A" "$TO&$A" "a next= that holds a whole encoded address"
A='a=1%262&b=x%7Cy&c=p|q&d=%20+%2B&e=%D7%A9%D7%9C%D7%95%D7%9D&f=&g&h=1=2'
goes "/if/flow/$SLUG/?$A" "$TO&$A" "an encoded &, an encoded and a bare |, a space three ways, Hebrew, empty and bare keys"
A='flow=other-flow&flow_token=tok'
goes "/if/flow/$SLUG/?$A" "$TO&$A" "its own flow= comes first; a flow= in the args follows, as sent"
A='state=a&state=b&STATE=c'
goes "/if/flow/$SLUG/?$A" "$TO&$A" "a repeated key keeps every copy, in order"
goes "/if/flow/$SLUG/" "$TO" "no args: no trailing & and no ?"
goes "/if/flow/$SLUG/?" "$TO" "a bare ?"
goes "/if/flow//$SLUG//?x=1" "$TO&x=1" "doubled slashes are the same address"

echo "--- only that slug, and only that exact address"
stays "/if/flow/default-authentication-flow/?next=%2F" "the sign-in flow"
stays "/if/flow/default-source-enrollment/?state=a&code=b" "the source's enrollment flow"
stays "/if/flow/default-source-pre-authentication/?state=a" "a slug that is near it"
stays "/if/flow/$SLUG-2/?state=a" "a slug that starts with it"
stays "/if/flow/x$SLUG/?state=a" "a slug that ends with it"
stays "/if/flow/DEFAULT-SOURCE-AUTHENTICATION/?state=a" "upper case"
stays "/if/flow/$SLUG?state=a" "no closing slash"
stays "/if/flow/$SLUG/extra?state=a" "a longer path under it"
stays "/x/if/flow/$SLUG/?state=a" "the same words deeper in a path"
stays "/if/flow/other/?next=%2Fif%2Fflow%2F$SLUG%2F" "another flow that names it in an arg"
stays "/if/flow/other/?x=/if/flow/$SLUG/" "another flow that names it in an arg, not encoded"
stays "/api/v3/flows/executor/$SLUG/?query=state%3Da" "the flow's own executor API"
stays "/source/oauth/callback/google/?state=a&code=b" "Google's callback itself"
stays "/if/admin/" "Authentik's admin"

echo "--- the redirects that were here before are as they were"
goes "/if/flow/gotcha-recovery/?flow_token=tok-123" "https://$APP/recover?flow=gotcha-recovery&flow_token=tok-123" "an invite link"
goes "/if/flow/gotcha-recovery-self/?flow_token=tok-123&x=1" "https://$APP/recover?flow=gotcha-recovery-self&flow_token=tok-123" "a password-reset link"
stays "/if/flow/gotcha-recovery/" "the recover flow with no token"
goes "/if/flow/default-authentication-flow/?next=%2Fapplication%2Fo%2Fgotcha%2Fend-session%2F" "https://$APP/sign-in" "a sign-out with no session left"
goes "/if/flow/gotcha-recovery/?flow_token=tok-123" "https://$APP/recover?flow=gotcha-recovery&flow_token=tok-123" "an invite link, on the product host" "$APP"

echo "--- on the product host the address still goes to the auth host first"
A='state=a&code=4%2F0Ab'
goes "/if/flow/$SLUG/?$A" "https://$AUTH/if/flow/$SLUG/?$A" "the product host hands /if/ to the auth host, args untouched" "$APP"

echo "---"
echo "$MODE: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
