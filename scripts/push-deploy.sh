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

# Verify sources exist before touching the network.
for f in "${SRC[@]}"; do
  [ -f "$f" ] || { echo "ERROR: missing local file: $f" >&2; exit 1; }
done

echo "→ target:  ubuntu@${INSTANCE_ID}:${REMOTE_DIR}  (region=${REGION} profile=${PROFILE})"
echo "→ files:   ${SRC[*]}"

# ── Copy ──────────────────────────────────────────────────────────────
# Relies on the ~/.ssh/config `host i-*` ProxyCommand to tunnel through SSM.
scp -i "$SSH_KEY" "${SRC[@]}" "ubuntu@${INSTANCE_ID}:${REMOTE_DIR}/"
echo "✓ pushed ${#SRC[@]} file(s)."

if [ "$OPEN_SHELL" -eq 1 ]; then
  echo "→ opening shell on ${INSTANCE_ID} ..."
  exec ssh -i "$SSH_KEY" "ubuntu@${INSTANCE_ID}"
fi
