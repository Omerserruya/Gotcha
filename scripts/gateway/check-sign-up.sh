#!/usr/bin/env bash
# Sign-up check: where the public sign-up screen and its submit go, against a
# local nginx.
#
#   scripts/gateway/check-sign-up.sh          # the prod template
#   scripts/gateway/check-sign-up.sh dev      # the dev template
#
# The rules under test (dev): on the AUTH host, the sign-up screen
# (/sign-up, /en/sign-up, /he/sign-up) is served by the sign-in app, and the
# form's submit, POST /api/auth/signup, goes to the auth service with the
# visitor's own address on it. The form's settings, GET
# /api/auth/signup/config, go there too: the page's server reads them through
# this host. Only those two exact paths of /api/auth are opened next to the
# setup accept; everything else on that host stays Authentik's.
# On the product host the auth, console and billing routes the feature uses go
# where they always went.
#
# Prod: the product host routes the same way. The prod auth host serves no
# sign-up screen today, and this check says so: it fails the day somebody
# opens one there without opening the submit path with it.
#
# It renders the WHOLE template the way the gateway does (the same envsubst
# list) and starts it in a throwaway nginx container on 127.0.0.1. Inside the
# same container a second, tiny nginx stands in for every upstream: each
# upstream name gets a loopback address of its own, and the stand-in answers
# with the address and port it was reached on and the headers it was sent. So
# the check reads which service a request reached, not only that it left.
#
# Nothing is built, nothing is written outside a temp folder, and the container
# and its network are removed on exit. Exit code 0 only when every check passes.
#
# Needs docker, curl and the nginx image the gateway is built on.
set -euo pipefail

MODE="${1:-prod}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${NGINX_IMAGE:-nginx:alpine}"
PORT="${CHECK_PORT:-18933}"
NAME="sign-up-check-$$"
VISITOR="203.0.113.7"

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

WORK="$(mktemp -d /tmp/sign-up-check.XXXXXX)"
cleanup() {
  docker stop "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
  case "$WORK" in /tmp/sign-up-check.*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT
mkdir -p "$WORK/out"

# ── Every upstream name gets its own loopback address ──
HOSTS=(); MAP="$WORK/map"; : > "$MAP"; n=10
for h in $(grep -oE '^\s*server\s+[a-z0-9-]+:' "$TEMPLATE" | awk '{print $2}' | tr -d ':' | sort -u); do
  n=$((n + 1))
  HOSTS+=(--add-host "$h:127.0.0.$n")
  echo "$h 127.0.0.$n" >> "$MAP"
done
addr_of() { awk -v h="$1" '$1 == h { print $2 }' "$MAP"; }

# ── The stand-in for every upstream ──
{
  echo 'pid /tmp/standin.pid; error_log /dev/null; events {}'
  echo 'http { access_log off; server {'
  for p in 3000 4001 4002 4003 4004 4005 4006 4007 4008 4009 8080 9000; do echo "  listen $p;"; done
  echo '  location / { default_type text/plain;'
  echo '    return 200 "UP $server_addr:$server_port $request_method $request_uri xri=[$http_x_real_ip] xff=[$http_x_forwarded_for] key=[$http_x_internal_key]\n"; }'
  echo '} }'
} > "$WORK/standin.conf"
chmod -R a+rX "$WORK"

docker network create "$NAME" >/dev/null
docker run -d --rm --name "$NAME" --network "$NAME" --network-alias authentik-server \
  -p "127.0.0.1:$PORT:80" "${HOSTS[@]}" \
  -v "$TEMPLATE:/etc/nginx/nginx.conf.template:ro" -v "$WORK/standin.conf:/etc/nginx/standin.conf:ro" \
  -e AUTH_PORT=4001 -e CONVERSATION_PORT=4002 -e WEBHOOK_PORT=4003 -e ANALYTICS_PORT=4004 \
  -e CHATBOT_PORT=4005 -e AI_PORT=4006 -e VOICE_COPILOT_PORT=4007 -e NOTIFICATIONS_PORT=4008 \
  -e BILLING_PORT=4009 -e AUTHENTIK_PORT=9000 -e FRONTEND_PORT=3000 \
  -e PUBLIC_PRICING_ENABLED=false -e TRUST_PUBLIC_URL= \
  "$IMAGE" sh -c "nginx -c /etc/nginx/standin.conf && $ENVSUBST < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && nginx -t && nginx -g 'daemon off;'" >/dev/null

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
# ask <method> <path> <host>: status in $CODE, the stand-in's line in $BODY. The
# visitor's address comes the way the edge sends it; the two forged headers are
# what a visitor might add on their own.
ask() {
  CODE="$(curl -s -m 10 --path-as-is -X "$1" -o "$WORK/out/b" -w '%{http_code}' \
    -H "Host: $3" -H "CF-Connecting-IP: $VISITOR" -H "X-Forwarded-For: 198.51.100.99" -H "X-Internal-Key: forged" \
    "http://127.0.0.1:$PORT$2")"
  BODY="$(head -1 "$WORK/out/b" | tr -d '\r')"
}
# reached: the upstream name the last answer came from, or "authentik", or "none".
reached() {
  case "$BODY" in
    "UP 127.0.0."*)
      local a="${BODY#UP }"; a="${a%%:*}"
      awk -v a="$a" '$2 == a { print $1; f = 1 } END { if (!f) print "unknown" }' "$MAP" ;;
    "UP "*":9000 "*) echo authentik ;;
    *) echo none ;;
  esac
}
# to <upstream> <method> <path> <host> <what>
to() {
  ask "$2" "$3" "$4"
  local got; got="$(reached)"
  [ "$CODE" = 200 ] && [ "$got" = "$1" ] && ok "$1  <- $5 ($2 $3)" || bad "$5 ($2 $3 on $4): status $CODE, reached $got, want $1"
}
# refused <method> <path> <host> <what>: answered 404 by the gateway itself, no service reached.
refused() {
  ask "$1" "$2" "$3"
  local got; got="$(reached)"
  [ "$CODE" = 404 ] && [ "$got" = none ] && ok "none  <- $4 ($1 $2)" || bad "$4 ($1 $2 on $3): status $CODE, reached $got, want a 404 from the gateway"
}
# carries <text> <what>: the last answer's line holds the text.
carries() { case "$BODY" in *"$1"*) ok "      $2" ;; *) bad "$2: $BODY" ;; esac; }

[ -n "$(addr_of auth)" ] && [ -n "$(addr_of billing)" ] || { echo "STOP: the template names no auth or billing upstream" >&2; exit 2; }

if [ "$MODE" = dev ]; then
  echo "--- the auth host: the sign-up screen is the sign-in app's"
  to frontend-auth GET "/sign-up" "$AUTH" "the bare address"
  to frontend-auth GET "/sign-up/" "$AUTH" "with a closing slash"
  to frontend-auth GET "/en/sign-up" "$AUTH" "English"
  to frontend-auth GET "/he/sign-up" "$AUTH" "Hebrew"
  to frontend-auth GET "/he/sign-up/" "$AUTH" "Hebrew, closing slash"
  to frontend-auth GET "/en/sign-up?plan=x" "$AUTH" "with a query"
  to frontend-auth GET "/en/sign-in" "$AUTH" "the sign-in screen, as before"
  to frontend-auth GET "/he/recover" "$AUTH" "the recover screen, as before"
  to authentik GET "/en/sign-upx" "$AUTH" "a longer word is not the screen"
  to authentik GET "/en/sign-ups/all" "$AUTH" "a longer word with a path"
  to authentik GET "/fr/sign-up" "$AUTH" "a locale the app does not have"
  to authentik GET "/en/Sign-Up" "$AUTH" "upper case"
  to authentik GET "/en/inbox" "$AUTH" "the product is not on this host"
  to authentik GET "/x/en/sign-up" "$AUTH" "the same words deeper in a path"

  echo "--- the auth host: the form's submit reaches the auth service, as this visitor"
  to auth POST "/api/auth/signup" "$AUTH" "the submit"
  carries "POST /api/auth/signup " "the address reaches the service unchanged"
  carries "xri=[$VISITOR]" "the service is told the visitor's own address"
  carries ", $VISITOR]" "the visitor's address is the LAST forwarded entry, the one the service counts"
  carries "key=[]" "an internal key the visitor sent is removed"
  to auth POST "/api/auth/signup?utm=a%26b" "$AUTH" "the submit with a query"
  carries "POST /api/auth/signup?utm=a%26b " "the query is passed as sent"

  echo "--- the auth host: the form's settings are a read, for the page's own server"
  to auth GET "/api/auth/signup/config" "$AUTH" "the settings"
  carries "GET /api/auth/signup/config " "the address reaches the service unchanged"
  carries "key=[]" "an internal key the caller sent is removed"
  to auth GET "/api/auth/signup/config?x=1" "$AUTH" "the settings with a query"
  refused POST "/api/auth/signup/config" "$AUTH" "a write to the settings"
  refused PUT "/api/auth/signup/config" "$AUTH" "a replace of the settings"
  refused DELETE "/api/auth/signup/config" "$AUTH" "a delete of the settings"
  to authentik GET "/api/auth/signup/config/" "$AUTH" "a closing slash"
  to authentik GET "/api/auth/signup/config/x" "$AUTH" "a longer path"
  to authentik GET "/api/auth/signup/configx" "$AUTH" "a longer word"
  to authentik GET "/API/AUTH/SIGNUP/CONFIG" "$AUTH" "upper case"

  echo "--- the auth host: nothing else of /api/auth is opened"
  to authentik POST "/api/auth/signup/" "$AUTH" "a closing slash"
  to authentik POST "/api/auth/signup/x" "$AUTH" "a longer path"
  to authentik POST "/api/auth/signupx" "$AUTH" "a longer word"
  to authentik POST "/api/auth/signup.json" "$AUTH" "with an ending"
  to authentik POST "/API/AUTH/SIGNUP" "$AUTH" "upper case"
  to authentik GET "/api/auth/me" "$AUTH" "who am I"
  to authentik POST "/api/auth/login" "$AUTH" "sign-in"
  to authentik GET "/api/auth/setup/tok123/state" "$AUTH" "a setup link's state"
  to authentik GET "/api/system/self-signup" "$AUTH" "the console's sign-up settings"
  to authentik PUT "/api/tenant/security/join-domain" "$AUTH" "the join-by-domain switch"
  to authentik POST "/api/billing/payment-methods/session" "$AUTH" "the card session"
  to auth POST "/api/auth/setup/tok123/accept" "$AUTH" "the setup accept, as before"
else
  echo "--- the prod auth host serves no sign-up screen today, and opens no submit path"
  to authentik GET "/sign-up" "$AUTH" "the bare address"
  to authentik GET "/en/sign-up" "$AUTH" "English"
  to authentik GET "/he/sign-up" "$AUTH" "Hebrew"
  to authentik POST "/api/auth/signup" "$AUTH" "the submit"
  to authentik GET "/api/auth/signup/config" "$AUTH" "the form's settings"
  to auth POST "/api/auth/setup/tok123/accept" "$AUTH" "the setup accept, as before"
fi

echo "--- the product host: what the feature calls goes where it always went"
to auth POST "/api/auth/signup" "$APP" "the submit"
carries "xri=[$VISITOR]" "the service is told the visitor's own address"
carries ", $VISITOR]" "the visitor's address is the last forwarded entry"
carries "key=[]" "an internal key the visitor sent is removed"
to auth GET "/api/auth/signup/config" "$APP" "the form's settings"
to auth GET "/api/system/self-signup" "$APP" "the console's sign-up settings"
to auth PUT "/api/system/self-signup" "$APP" "saving them"
to auth GET "/api/tenant/security/join-domain" "$APP" "the join-by-domain switch, read"
to auth PUT "/api/tenant/security/join-domain" "$APP" "the join-by-domain switch, set"
to billing GET "/api/checkout/mine" "$APP" "why the organization is blocked"
to billing POST "/api/billing/payment-methods/session" "$APP" "the card session"
to billing POST "/api/billing/payment-methods/confirm" "$APP" "the card confirm"

echo "---"
echo "$MODE: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
