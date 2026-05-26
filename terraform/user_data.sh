#!/bin/bash
# Cloud-init bootstrap for the ChatCenter single-EC2 box (Ubuntu 22.04 ARM).
# Idempotent — safe to re-run by hand. Logs to /var/log/cloud-init-output.log.
#
# What this does:
#   1. Base packages (Docker, docker-compose plugin, AWS CLI, jq)
#   2. CloudWatch agent (so the disk_used_percent alarm has data)
#   3. cloudflared (you create + auth the tunnel manually afterwards)
#   4. 2GB swap (cheap safety net on a t4g.large)
#   5. /opt/chatcenter app dir + nightly backup cron skeleton
#
# What this does NOT do (intentional — keeps Terraform decoupled from app):
#   - Clone the repo
#   - Write .env files
#   - Start docker compose
#   - Register the Cloudflare tunnel
# You do those by hand after the box is up. See terraform/README.md.

set -euo pipefail
exec > >(tee -a /var/log/chatcenter-bootstrap.log) 2>&1

PROJECT="${project}"
ENV_NAME="${env}"
REGION="${region}"
BACKUP_BUCKET="${backup_bucket}"

echo "[bootstrap] starting at $(date -Iseconds)"

# ── 1. Base packages ─────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  jq unzip cron \
  awscli

# Docker (official repo, ARM64)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# ── 2. CloudWatch agent ──────────────────────────────────────────────
# Pushes disk_used_percent so the cloudwatch.tf disk alarm has data.
curl -fsSL -o /tmp/amazon-cloudwatch-agent.deb \
  "https://s3.$${REGION}.amazonaws.com/amazoncloudwatch-agent-$${REGION}/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb" || \
curl -fsSL -o /tmp/amazon-cloudwatch-agent.deb \
  "https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb"

dpkg -i /tmp/amazon-cloudwatch-agent.deb

cat >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'JSON'
{
  "metrics": {
    "namespace": "CWAgent",
    "append_dimensions": { "InstanceId": "$${aws:InstanceId}" },
    "metrics_collected": {
      "disk": {
        "measurement": ["used_percent"],
        "resources": ["/"],
        "metrics_collection_interval": 300
      },
      "mem": {
        "measurement": ["mem_used_percent"],
        "metrics_collection_interval": 300
      }
    }
  }
}
JSON

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json || true

# ── 3. cloudflared ───────────────────────────────────────────────────
# Installed but NOT registered. Finish setup by hand:
#   cloudflared tunnel login
#   cloudflared tunnel create prod
#   cloudflared tunnel route dns prod app.yourdomain.com
#   then write /etc/cloudflared/config.yml + `cloudflared service install`
curl -fsSL -o /tmp/cloudflared.deb \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb"
dpkg -i /tmp/cloudflared.deb

# ── 4. Swap (2GB) ────────────────────────────────────────────────────
# Safety net so a transient memory spike doesn't OOM-kill Postgres.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 5. App directory + nightly backup cron ───────────────────────────
install -d -o ubuntu -g ubuntu /opt/chatcenter
install -d -o ubuntu -g ubuntu /opt/chatcenter/backups

# Backup script — runs nightly via cron. Reads env from /opt/chatcenter/.env
# (which YOU create after deploying the app) for Postgres credentials.
cat >/usr/local/bin/chatcenter-backup.sh <<EOF
#!/bin/bash
set -euo pipefail

# Load app env so we get POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD.
if [ -f /opt/chatcenter/.env ]; then
  set -a; . /opt/chatcenter/.env; set +a
fi

BUCKET="$${BACKUP_BUCKET}"
STAMP=\$(date -u +%Y-%m-%d)
TMPDIR=\$(mktemp -d)
trap "rm -rf \$TMPDIR" EXIT

# Postgres dump via the running compose container.
if docker compose -f /opt/chatcenter/docker-compose.yml ps db --status running -q | grep -q .; then
  docker compose -f /opt/chatcenter/docker-compose.yml exec -T db \
    pg_dump -U "\$${POSTGRES_USER:-postgres}" "\$${POSTGRES_DB:-whatsapp_cc}" \
    | gzip > "\$TMPDIR/db-\$STAMP.sql.gz"
  aws s3 cp "\$TMPDIR/db-\$STAMP.sql.gz" "s3://\$BUCKET/db/db-\$STAMP.sql.gz"
fi

# Uploads volume tarball.
UPLOADS_PATH="/var/lib/docker/volumes/chatcenter_uploads/_data"
if [ -d "\$UPLOADS_PATH" ]; then
  tar -czf "\$TMPDIR/uploads-\$STAMP.tar.gz" -C "\$UPLOADS_PATH" .
  aws s3 cp "\$TMPDIR/uploads-\$STAMP.tar.gz" "s3://\$BUCKET/uploads/uploads-\$STAMP.tar.gz"
fi

echo "[backup] done \$STAMP"
EOF
chmod +x /usr/local/bin/chatcenter-backup.sh

# Run every day at 02:30 UTC (before the 03:00 DLM snapshot).
cat >/etc/cron.d/chatcenter-backup <<EOF
30 2 * * * root /usr/local/bin/chatcenter-backup.sh >> /var/log/chatcenter-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/chatcenter-backup

# ── Done ─────────────────────────────────────────────────────────────
echo "[bootstrap] done at $(date -Iseconds)"
echo "[bootstrap] next steps: see /opt/chatcenter (clone repo, write .env, register cloudflared tunnel)"
