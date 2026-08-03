#!/usr/bin/env bash
# Push the host-side deploy files (docker-compose.prod.yml + .env) to the prod
# EC2 box over an SSM SSH tunnel - no open port 22, no public IP.
#
# Prereqs (one-time, see DEPLOY.md Step 6):
#   • session-manager-plugin installed locally
#   • your public key in the box's ~ubuntu/.ssh/authorized_keys
#   • ~/.ssh/config has the `host i-* mi-*` ProxyCommand block
#
# Usage:
#   ./scripts/push-deploy.sh                 # push compose + .env to the box
#   ./scripts/push-deploy.sh --shell         # push, then drop into a shell on the box
#   ./scripts/push-deploy.sh --no-env        # push only docker-compose.prod.yml
#   FILES="docker-compose.prod.yml nginx.conf" ./scripts/push-deploy.sh   # custom file list
#
# Override defaults via env: REGION, PROFILE, INSTANCE_ID, SSH_KEY, REMOTE_DIR

set -euo pipefail

# ── Config (override via env) ─────────────────────────────────────────
REGION="${REGION:-il-central-1}"
PROFILE="${PROFILE:-gotcha}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${REMOTE_DIR:-/opt/chatcenter}"
PROJECT="${PROJECT:-gotcha}"
ENV_NAME="${ENV_NAME:-prod}"

# Run from the repo root regardless of where the script is called from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Resolve instance id ───────────────────────────────────────────────
# Prefer terraform output; fall back to the EC2 Name tag.
if [ -z "${INSTANCE_ID:-}" ]; then
  INSTANCE_ID="$(terraform -chdir=terraform output -raw instance_id 2>/dev/null || true)"
fi
if [ -z "${INSTANCE_ID:-}" ]; then
  INSTANCE_ID="$(aws ec2 describe-instances \
    --region "$REGION" --profile "$PROFILE" \
    --filters "Name=tag:Name,Values=${PROJECT}-${ENV_NAME}-app" \
              "Name=instance-state-name,Values=running" \
    --query "Reservations[].Instances[].InstanceId" --output text 2>/dev/null || true)"
fi
if [ -z "${INSTANCE_ID:-}" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "ERROR: could not resolve instance id. Set INSTANCE_ID=i-xxxx and retry." >&2
  exit 1
fi

# ── Build the file list ───────────────────────────────────────────────
OPEN_SHELL=0
WITH_ENV=1
for arg in "$@"; do
  case "$arg" in
    --shell)  OPEN_SHELL=1 ;;
    --no-env) WITH_ENV=0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ -n "${FILES:-}" ]; then
  # Caller supplied an explicit space-separated list.
  read -r -a SRC <<< "$FILES"
else
  SRC=(docker-compose.prod.yml)
  if [ "$WITH_ENV" -eq 1 ]; then
    # .env.prod FIRST, and deliberately so. This script targets the production
    # box, while `.env` on a developer machine is the DEV environment - dev
    # hostnames, dev Meta app, dev Shopify app, dev database password. Sending
    # it lands as `.env` in /opt/chatcenter and the next `up -d` runs
    # production against Dev configuration, which is both an outage and a
    # cross-environment data leak. Preferring `.env` here was that mistake
    # waiting to be made.
    if [ -f .env.prod ]; then
      ENV_SRC=".env.prod"
    elif [ -f .env.example ]; then
      echo "NOTE: no local .env.prod - sending .env.example (edit on the box)."
      ENV_SRC=".env.example"
    else
      echo "ERROR: no .env.prod found. Refusing to send a developer .env to production." >&2
      exit 1
    fi
    # It has to arrive named `.env`, which is what compose reads on the box.
    STAGED_ENV="$(mktemp -d)/.env"
    cp "$ENV_SRC" "$STAGED_ENV"
    echo "→ env file: $ENV_SRC (lands as .env)"
    SRC+=("$STAGED_ENV")
  fi
fi

# ── Files the compose file BIND-MOUNTS from the host ─────────────────
# The box runs images and needs no source tree, with these six exceptions:
# docker-compose.prod.yml mounts them into the Authentik containers for
# branding and the password-reset email template.
#
# Forgetting them does not produce a missing-file error. Docker AUTO-CREATES a
# missing bind source as an empty DIRECTORY, then refuses to mount a directory
# onto a file:
#
#   error mounting "/opt/chatcenter/scripts/authentik/custom.css" to rootfs at
#   "/web/dist/custom.css": not a directory
#
# which is an obscure way of being told "you forgot to copy a file", and it
# only surfaces at `up -d`, after the images have been pulled. They also have
# to arrive with their paths intact, so this is a tar stream rather than scp.
MOUNTED_ASSETS=(
  scripts/authentik/custom.css
  scripts/authentik/templates/gotcha_password_reset.html
  frontend/public/logo_icon.png
  frontend/public/favicon.ico
  frontend/public/full_icon_white.png
  frontend/public/authentik-enhance.js
)

# Verify sources exist before touching the network.
for f in "${SRC[@]}"; do
  [ -f "$f" ] || { echo "ERROR: missing local file: $f" >&2; exit 1; }
done
for f in "${MOUNTED_ASSETS[@]}"; do
  [ -f "$f" ] || { echo "ERROR: missing bind-mount asset: $f" >&2; exit 1; }
done

echo "→ target:  ubuntu@${INSTANCE_ID}:${REMOTE_DIR}  (region=${REGION} profile=${PROFILE})"
echo "→ files:   ${SRC[*]}"
echo "→ assets:  ${#MOUNTED_ASSETS[@]} bind-mounted files (paths preserved)"

# ── Copy ──────────────────────────────────────────────────────────────
# Relies on the ~/.ssh/config `host i-*` ProxyCommand to tunnel through SSM.
scp -i "$SSH_KEY" "${SRC[@]}" "ubuntu@${INSTANCE_ID}:${REMOTE_DIR}/"

# Clear anything Docker already auto-created at an asset path on a previous
# failed `up`, then stream the assets across with their directory structure.
#
# sudo is required and not optional. Docker creates those placeholders as
# ROOT - both the empty directory itself and every parent it had to make - so
# the ubuntu user cannot remove them, and tar cannot write into them:
#
#   rm: cannot remove '.../custom.css': Permission denied
#   tar: scripts/authentik/custom.css: Cannot open: File exists
#
# The chown is the other half. Deleting the placeholder is not enough when
# `/opt/chatcenter/scripts` itself is still root-owned, because tar runs as
# ubuntu and cannot create a file inside it. Scoped to the top-level
# directories our own assets live in, derived from the asset list rather than
# hardcoded, so it can never widen to something we do not own.
ASSET_ROOTS=()
for f in "${MOUNTED_ASSETS[@]}"; do
  top="${f%%/*}"
  case " ${ASSET_ROOTS[*]:-} " in *" $top "*) ;; *) ASSET_ROOTS+=("$top") ;; esac
done

REMOTE_PREP="set -e; cd '${REMOTE_DIR}'; "
for f in "${MOUNTED_ASSETS[@]}"; do
  REMOTE_PREP+="sudo rm -rf './${f}'; "
done
for d in "${ASSET_ROOTS[@]}"; do
  REMOTE_PREP+="sudo mkdir -p './${d}'; sudo chown -R ubuntu:ubuntu './${d}'; "
done
ssh -i "$SSH_KEY" "ubuntu@${INSTANCE_ID}" "$REMOTE_PREP"

tar czf - "${MOUNTED_ASSETS[@]}" \
  | ssh -i "$SSH_KEY" "ubuntu@${INSTANCE_ID}" "tar xzf - -C '${REMOTE_DIR}'"

# Confirm they landed as FILES. A silent re-creation as a directory is the
# whole failure mode, so assert rather than assume.
REMOTE_VERIFY="cd '${REMOTE_DIR}'; bad=0; "
for f in "${MOUNTED_ASSETS[@]}"; do
  REMOTE_VERIFY+="[ -f './${f}' ] || { echo \"NOT A FILE: ${f}\" >&2; bad=1; }; "
done
REMOTE_VERIFY+="exit \$bad"
ssh -i "$SSH_KEY" "ubuntu@${INSTANCE_ID}" "$REMOTE_VERIFY" \
  || { echo "ERROR: bind-mount assets did not land as files." >&2; exit 1; }
echo "✓ pushed ${#MOUNTED_ASSETS[@]} bind-mount asset(s), verified as files."
echo "✓ pushed ${#SRC[@]} file(s)."

if [ "$OPEN_SHELL" -eq 1 ]; then
  echo "→ opening shell on ${INSTANCE_ID} ..."
  exec ssh -i "$SSH_KEY" "ubuntu@${INSTANCE_ID}"
fi
