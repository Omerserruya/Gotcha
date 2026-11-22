#!/usr/bin/env bash
# Demo pages check: the /demo/<id> location, against a local nginx.
#
#   scripts/gateway/check-demo-pages.sh          # the prod template (gotcha.co.il)
#   scripts/gateway/check-demo-pages.sh dev      # the dev template
#
# It renders the WHOLE template the way the gateway does (the same envsubst
# list), starts it in a throwaway nginx container on 127.0.0.1 with a fixture
# drop folder mounted read-only at /srv/demo-pages, and asks it over HTTP.
# Nothing is built, nothing outside a temp folder is written, and the container
# is stopped on exit. Exit code 0 only when every check passes.
#
# Needs docker, curl and the nginx image the gateway is built on.
set -euo pipefail

MODE="${1:-prod}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${NGINX_IMAGE:-nginx:alpine}"
PORT="${CHECK_PORT:-18931}"
NAME="demo-pages-check-$$"
ID="abc123defg"
OTHER="other12345"

case "$MODE" in
  prod)
    TEMPLATE="$ROOT/gateway/nginx.prod.conf.template"
    HOST="gotcha.co.il"
    ENVSUBST="$(grep -o "envsubst '[^']*'" "$ROOT/gateway/Dockerfile.prod" | tail -1)"
    ;;
  dev)
    TEMPLATE="$ROOT/nginx/nginx.conf.template"
    HOST="dev.gotcha.co.il"
    ENVSUBST="$(grep -o "envsubst '[^']*'" "$ROOT/docker-compose.yml" | head -1 | sed 's/\$\$/$/g')"
    ;;
  *) echo "usage: $0 [prod|dev]" >&2; exit 2 ;;
esac
[ -n "$ENVSUBST" ] || { echo "STOP: no envsubst list found for $MODE" >&2; exit 2; }

WORK="$(mktemp -d /tmp/demo-pages-check.XXXXXX)"
cleanup() {
  docker stop "$NAME" >/dev/null 2>&1 || true
  case "$WORK" in /tmp/demo-pages-check.*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT

# ── Fixture ────────────────────────────────────────────────
D="$WORK/demo"
mkdir -p "$D/$ID/assets/img" "$D/$ID/assets/dir" "$D/$ID/other" "$D/$OTHER" "$WORK/landing" "$WORK/out"
echo "<!doctype html><title>demo</title>DEMO-PAGE-$ID" > "$D/$ID/index.html"
echo "<!doctype html><title>demo</title>DEMO-PAGE-$OTHER" > "$D/$OTHER/index.html"
echo "body{color:red} /* DEMO-ASSET */" > "$D/$ID/assets/style.css"
echo "<svg xmlns='http://www.w3.org/2000/svg'/>" > "$D/$ID/assets/img/logo.svg"
echo "DEMO-SECRET" > "$D/$ID/secret.txt"
echo "DEMO-SECRET" > "$D/$ID/other/x.txt"
echo "DEMO-SECRET" > "$D/$ID/assets/.hidden"
echo "DEMO-SECRET" > "$D/$ID/assets/dir/index.html"
echo "DEMO-SECRET" > "$D/secret-at-root.txt"
echo "DEMO-UNREADABLE" > "$D/$ID/assets/private.css"
# Folders that DO hold a page under a name that is not an id: the 404 must come from the
# rule, not from the folder being absent.
for badid in abc123def abc123defgh abc123defgx ABC123DEFG abc123def_; do
  mkdir -p "$D/$badid"
  echo "<!doctype html>DEMO-PAGE-$badid" > "$D/$badid/index.html"
done
# A folder named demo inside the drop folder: the address /demo/<id>/secret.txt would
# map onto it if anything under /demo/ were served straight from the folder.
mkdir -p "$D/demo/$ID"
echo "DEMO-SECRET" > "$D/demo/$ID/secret.txt"
echo "DEMO-SECRET" > "$D/demo/index.html"
# Links: a file outside the folder, and a second id that is only a link.
ln -s /etc/passwd "$D/$ID/assets/link.css"
ln -s "$ID" "$D/linkedid00"
# A file of the same address inside the site's own files: /demo never reads from there.
mkdir -p "$WORK/landing/demo/$ID"
echo "DEMO-SECRET" > "$WORK/landing/demo/$ID/pic.png"
echo "<!doctype html>LANDING-HOME" > "$WORK/landing/index.html"
echo "<!doctype html>LANDING-404" > "$WORK/landing/404.html"
chmod -R a+rX "$WORK"
chmod 600 "$D/$ID/assets/private.css"

# ── The gateway, whole template, upstream names pointed at nothing ──
HOSTS=()
for h in $(grep -oE '^\s*server\s+[a-z0-9-]+:' "$TEMPLATE" | awk '{print $2}' | tr -d ':' | sort -u); do
  HOSTS+=(--add-host "$h:127.0.0.1")
done
MOUNTS=(-v "$TEMPLATE:/etc/nginx/nginx.conf.template:ro" -v "$D:/srv/demo-pages:ro")
[ "$MODE" = prod ] && MOUNTS+=(-v "$WORK/landing:/usr/share/nginx/landing:ro")

docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:80" "${HOSTS[@]}" "${MOUNTS[@]}" \
  -e AUTH_PORT=4001 -e CONVERSATION_PORT=4002 -e WEBHOOK_PORT=4003 -e ANALYTICS_PORT=4004 \
  -e CHATBOT_PORT=4005 -e AI_PORT=4006 -e VOICE_COPILOT_PORT=4007 -e NOTIFICATIONS_PORT=4008 \
  -e BILLING_PORT=4009 -e AUTHENTIK_PORT=9000 -e FRONTEND_PORT=3000 \
  -e PUBLIC_PRICING_ENABLED=false -e TRUST_PUBLIC_URL= \
  "$IMAGE" sh -c "$ENVSUBST < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && nginx -t && nginx -g 'daemon off;'" >/dev/null

up=0
for _ in $(seq 1 40); do
  if curl -s -o /dev/null -H "Host: $HOST" "http://127.0.0.1:$PORT/health"; then up=1; break; fi
  sleep 0.25
done
if [ "$up" != 1 ]; then
  echo "STOP: nginx did not start. Its log:"; docker logs "$NAME" 2>&1 | tail -20; exit 1
fi
echo "nginx: $(docker exec "$NAME" nginx -v 2>&1) | template: ${TEMPLATE#"$ROOT"/} | host: $HOST"

# ── Asking ─────────────────────────────────────────────────
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok    $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }
# get <path> [host]: status in $CODE, headers in out/h, body in out/b. The path goes as written.
get() {
  CODE="$(curl -s --path-as-is -o "$WORK/out/b" -D "$WORK/out/h" -w '%{http_code}' -H "Host: ${2:-$HOST}" "http://127.0.0.1:$PORT$1")"
}
hdr() { { grep -i "^$1:" "$WORK/out/h" || true; } | tail -1 | sed 's/^[^:]*: *//' | tr -d '\r'; }
body_has() { grep -q "$1" "$WORK/out/b"; }

SEC="X-Content-Type-Options Referrer-Policy Strict-Transport-Security X-Frame-Options Permissions-Policy Content-Security-Policy"

# The headers this server sends on its own page: the demo page must send the same ones.
if [ "$MODE" = prod ]; then get "/"; else get "/health"; fi
for h in $SEC; do eval "BASE_${h//-/_}=\"\$(hdr $h)\""; done
if [ "$MODE" = prod ]; then
  [ "$CODE" = 200 ] && body_has LANDING-HOME && ok "the site's own home page still serves (200)" || bad "home page: $CODE"
  [ -n "$BASE_Content_Security_Policy" ] && ok "the home page carries a CSP to compare with" || bad "home page has no CSP"
fi

served() { # served <path> <marker> <content-type prefix> <what>
  get "$1"
  local why=""
  [ "$CODE" = 200 ] || why="$why status=$CODE"
  body_has "$2" || why="$why body"
  case "$(hdr Content-Type)" in "$3"*) ;; *) why="$why type=$(hdr Content-Type)" ;; esac
  [ "$(hdr X-Robots-Tag)" = "noindex, nofollow" ] || why="$why robots=$(hdr X-Robots-Tag)"
  [ "$(hdr Cache-Control)" = "no-store" ] || why="$why cache=$(hdr Cache-Control)"
  if [ "$MODE" = prod ]; then
    for h in $SEC; do
      eval "want=\"\$BASE_${h//-/_}\""
      [ -n "$want" ] && [ "$(hdr "$h")" = "$want" ] || why="$why $h"
    done
  else
    for h in $SEC; do [ -n "$(hdr "$h")" ] || why="$why $h"; done
  fi
  [ -z "$why" ] && ok "$4: 200, noindex, no-store, the server's security headers ($1)" || bad "$4 ($1):$why"
}

refused() { # refused <path> <what>
  get "$1"
  local why=""
  [ "$CODE" = 404 ] || why="$why status=$CODE"
  [ -z "$(hdr Location)" ] || why="$why location=$(hdr Location)"
  body_has "DEMO-" && why="$why leaked-body"
  grep -qi "Index of" "$WORK/out/b" && why="$why listing"
  grep -q "root:" "$WORK/out/b" && why="$why leaked-file"
  [ "$MODE" = prod ] && [ -z "${3:-}" ] && { body_has LANDING-404 || why="$why not-the-404-page"; }
  [ -z "$why" ] && ok "404  $2 ($1)" || bad "$2 ($1):$why"
}
# A dot segment is refused before any location runs, so it gets nginx's bare 404, not the site's page.
dotted() { refused "$1" "$2" bare; }

echo "--- a valid id serves"
served "/demo/$ID" "DEMO-PAGE-$ID" "text/html" "the page"
served "/demo/$ID/" "DEMO-PAGE-$ID" "text/html" "the page, with the slash"
served "/demo/$ID/index.html" "DEMO-PAGE-$ID" "text/html" "the page, by its file name"
served "/demo/$ID?utm_source=x&fbclid=1" "DEMO-PAGE-$ID" "text/html" "the page, with a tracking query"
served "/demo/$ID/assets/style.css" "DEMO-ASSET" "text/css" "an asset"
served "/demo/$ID/assets/img/logo.svg" "svg" "image/svg+xml" "an asset in a subfolder"
served "/demo/$OTHER" "DEMO-PAGE-$OTHER" "text/html" "a second id"

echo "--- a bad id is 404"
refused "/demo/abc123def" "9 characters"
refused "/demo/abc123defgh" "11 characters"
refused "/demo/ABC123DEFG" "upper case"
refused "/demo/abc123def_" "a character outside a-z0-9"
refused "/demo/abc123def%67x" "an encoded character making 11"
refused "/demo/nosuchid00" "an id with no folder"
refused "/demo/" "the folder itself (no listing)"
refused "/demo" "the bare prefix"
refused "/demo/secret-at-root.txt" "a file beside the ids"

echo "--- under an id only index.html and assets/ exist"
refused "/demo/$ID/secret.txt" "another file of the id"
refused "/demo/$ID/other/x.txt" "another folder of the id"
refused "/demo/$ID/index.htmlx" "a name that only starts like index.html"
[ "$MODE" = prod ] && refused "/demo/$ID/pic.png" "a file the site's own image rule would have served"
refused "/demo/$ID/assets" "the assets folder, no slash"
refused "/demo/$ID/assets/" "the assets folder (no listing)"
refused "/demo/$ID/assets/dir" "a folder under assets"
refused "/demo/$ID/assets/dir/" "a folder under assets, with the slash (no index, no listing)"
refused "/demo/$ID/assets/.hidden" "a hidden file"
refused "/demo/$ID/assets/missing.css" "an asset that is not there"

echo "--- ../ traversal is 404"
dotted "/demo/$ID/../../etc/passwd" "out of /demo to a system file"
dotted "/demo/../etc/passwd" "out of /demo at once"
dotted "/demo/$ID/assets/../secret.txt" "from assets to the id's other file"
dotted "/demo/$ID/assets/../../secret-at-root.txt" "from assets to the drop folder"
dotted "/demo/$ID/assets/../../$OTHER/index.html" "from one id to another"
dotted "/demo/$ID/%2e%2e/%2e%2e/etc/passwd" "encoded dots"
dotted "/demo/$ID/assets/..%2f..%2f..%2fetc%2fpasswd" "encoded slashes"
dotted "/demo/$ID/assets/%2E%2E%2Fsecret.txt" "encoded, upper case"
dotted "/demo/$ID/.." "a dot segment at the end"
dotted "/demo/$ID/assets/..?x=1" "a dot segment before a query"

echo "--- links and unreadable files"
refused "/demo/$ID/assets/link.css" "a link to a file outside the folder"
refused "/demo/linkedid00" "an id that is only a link"
get "/demo/$ID/assets/private.css"
{ [ "$CODE" = 404 ] || [ "$CODE" = 403 ]; } && ! body_has DEMO-UNREADABLE \
  && ok "$CODE  a file others cannot read is not served (the drop folder's files must be readable by others)" \
  || bad "an unreadable file: $CODE"

if [ "$MODE" = prod ]; then
  echo "--- the rest of the server is as it was"
  for p in /dashboard /login /demonstration /demos/x "/inbox?c=1"; do
    get "$p"
    [ "$CODE" = 301 ] && [ "$(hdr Location)" = "https://app.gotcha.co.il$p" ] \
      && ok "301  an application path still goes to the application ($p)" || bad "$p: $CODE $(hdr Location)"
  done
  get "/health"; [ "$CODE" = 200 ] && ok "200  /health" || bad "/health: $CODE"
  get "/demo/$ID" "app.gotcha.co.il"
  [ "$CODE" != 200 ] && ! body_has "DEMO-PAGE" && ok "$CODE  the application host does not serve demo pages" || bad "app host served a demo page: $CODE"
  get "/demo/$ID" "go.gotcha.co.il"
  [ "$CODE" != 200 ] && ! body_has "DEMO-PAGE" && ok "$CODE  the campaign host does not serve demo pages" || bad "campaign host served a demo page: $CODE"
fi

echo "---"
echo "$MODE: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
