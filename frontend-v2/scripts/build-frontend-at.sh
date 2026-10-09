#!/usr/bin/env bash
#
# Build EITHER frontend image FROM A COMMIT, not from the working tree.
#
#   build-frontend-at.sh frontend-v2   [ref]
#   build-frontend-at.sh frontend-auth [ref]
#
# ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
#
# A build from the working tree cannot be attributed to a commit. The app's
# directory is a shared checkout that several sessions edit, and on 2026-09-27
# `git status` read clean, `COPY . .` then captured a half-written symbol that
# existed in no commit, and the build failed with type errors in source nobody
# had committed - which read as "Frontend's commit does not compile". Every
# reading was true, of a different tree. `git archive <ref>:<app dir>`
# materialises exactly what is committed, so a green result names a ref.
# (This replaces build-v2-at.sh, which did the same for frontend-v2 only.)
#
# ★ The app lives in a subdirectory of the GOTCHA monorepo. Both the repo and
#   the subdirectory are found from this script's own location, so moving or
#   renaming the directory cannot leave a stale path here.
#
# ── ★★ AND THE REASON IT IS ONE SCRIPT AND NOT TWO ────────────────────────────
#
# The auth image was built by hand, once, because no script took a service
# name. It then sat three commits behind the product image while both were
# described as "deployed" — and the only thing keeping that safe was that the
# missing commits happened to be inert on that service. That is luck, not
# design. Two build paths drift; one does not.
#
# ── ⚠ THE QUOTING BUG THIS FILE EXISTS TO NOT REPEAT ──────────────────────────
#
# `docker compose config frontend-auth` prints
#
#     NEXT_PUBLIC_BASE_PATH: ""
#
# because the value IS the empty string. The obvious sed lifts `""` as the
# VALUE, and `--build-arg NEXT_PUBLIC_BASE_PATH='""'` bakes a two-character
# basePath of two quote marks into the bundle. Every route would be served from
# `/""/...`. Nothing warns; the image builds clean.
#
# ★ Note this is exactly the empty-vs-absent distinction the compose file
#   already documents for NEXT_PUBLIC_APP_ENV — an ARG with an empty value is
#   SET, and a zod `.default()` applies only to `undefined`. So the empty string
#   must be passed AS an empty string: not quoted, and not omitted.
#
# ── ★ THE PROBE IS BUILT IN ───────────────────────────────────────────────────
#
# After the build, the baked basePath is read back out of the image and checked
# against the arg that went in. A build whose output does not match its input is
# not reported as success. Every guard in this project has, at least once, been
# written from the shape of the thing it was meant to catch and then failed to
# catch it; a check that only runs when somebody remembers is not a check.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
# The app's directory inside the monorepo, e.g. `frontend-v2` - no slashes at
# either end, as `<ref>:<path>` wants it.
APP=$(git -C "$HERE" rev-parse --show-prefix)
APP=${APP%/}
COMPOSE=$REPO
if [ -z "$APP" ]; then
  echo "refusing: $HERE is the repo root, not an app directory inside it" >&2
  exit 1
fi

SERVICE="${1:-}"
case "$SERVICE" in
  frontend-v2 | frontend-auth) ;;
  *)
    echo "usage: $(basename "$0") <frontend-v2|frontend-auth> [ref]" >&2
    exit 2
    ;;
esac
IMAGE="chatcenter-$SERVICE"
REF="${2:-rebrand/v2}"

SHA=$(git -C "$REPO" rev-parse --short "$REF")
SRC=$(mktemp -d /tmp/claude-1000/fesrc-XXXXXX)
trap 'rm -rf "$SRC"' EXIT

# A ref from before the import has no such directory: say so, rather than
# archiving nothing and building an empty context.
if ! git -C "$REPO" cat-file -e "$REF:$APP" 2>/dev/null; then
  echo "refusing: $REF has no $APP/ (a ref from before the app was imported?)" >&2
  exit 1
fi

echo "── materialising $REF:$APP ($SHA) for $SERVICE ──"
git -C "$REPO" archive "$REF:$APP" | tar -x -C "$SRC"

# Read the args out of compose rather than restating them: they are inlined by
# `next build`, and a drift between this script and the service definition is
# invisible until a screen misbehaves.
#
# ⚠ The value is unquoted deliberately — see the header. `""` means empty.
mapfile -t KV < <(
  cd "$COMPOSE" && docker compose config "$SERVICE" \
    | sed -n '/^ *args:$/,/^ *environment:$/p' \
    | sed -n 's/^ *\(NEXT_PUBLIC_[A-Z_]*\): \(.*\)$/\1=\2/p'
)
if [ "${#KV[@]}" -eq 0 ]; then
  echo "refusing: read no NEXT_PUBLIC_* build args out of compose for $SERVICE" >&2
  exit 1
fi

ARGS=()
BASE_PATH_IN=""
BASE_PATH_SEEN=0
for kv in "${KV[@]}"; do
  key=${kv%%=*}
  val=${kv#*=}
  # strip ONE layer of surrounding quotes, which is how compose renders an
  # empty (or whitespace-bearing) value
  case "$val" in
    '"'*'"') val=${val:1:${#val}-2} ;;
    "'"*"'") val=${val:1:${#val}-2} ;;
  esac
  if [ "$key" = NEXT_PUBLIC_BASE_PATH ]; then
    BASE_PATH_IN=$val
    BASE_PATH_SEEN=1
  fi
  ARGS+=(--build-arg "$key=$val")
done

printf '── build args ──\n'
for ((i = 1; i < ${#ARGS[@]}; i += 2)); do printf '   %s\n' "${ARGS[i]}"; done

docker build "${ARGS[@]}" -t "$IMAGE:latest" -t "$IMAGE:$SHA" "$SRC"

# ── ★ read the basePath back OUT of the image it just produced ────────────────
if [ "$BASE_PATH_SEEN" -eq 1 ]; then
  BAKED=$(docker run --rm --entrypoint node "$IMAGE:$SHA" \
    -e 'process.stdout.write(String(require("/app/.next/required-server-files.json").config.basePath ?? ""))' 2>/dev/null || echo '<unreadable>')
  if [ "$BAKED" != "$BASE_PATH_IN" ]; then
    echo >&2
    echo "★★ REFUSING TO REPORT SUCCESS: the image does not carry the arg it was given." >&2
    echo "   NEXT_PUBLIC_BASE_PATH in : '$BASE_PATH_IN'" >&2
    echo "   basePath baked into image: '$BAKED'" >&2
    echo "   (this is the failure the quoting note in this file's header describes)" >&2
    exit 1
  fi
  echo "── basePath verified: in '$BASE_PATH_IN' == baked '$BAKED' ──"
fi

echo
echo "── built $IMAGE:$SHA ──"
echo "   recreate with:  docker compose up -d --no-deps --no-build $SERVICE"
echo "   (--no-deps, because recreating a platform service hands it a new IP"
echo "    and the gateway resolves its upstreams once, at startup; then"
echo "    docker exec chatcenter-gateway-1 nginx -s reload)"
