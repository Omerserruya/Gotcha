# ChatCenter — Production Deploy Guide

End-to-end runbook: from a fresh AWS account to a live production system on a single EC2.

**Target stage:** 5–7 tenants, ~4 agents each. **Cost:** ~$45/mo AWS infra after Savings Plan.

---

## 📐 Architecture

```
Internet
   ↓
Cloudflare (DNS + TLS + WAF + DDoS — free tier)
   ↓
Cloudflare Tunnel (outbound, no inbound ports)
   ↓
AWS EC2 (t4g.large, ARM, default VPC, no public-facing services)
   └─ docker-compose.prod.yml
       ├─ nginx (gateway)
       ├─ 8 services: auth, conversation, webhook, analytics, chatbot, ai, voice-copilot, notifications
       ├─ 2 workers: incoming, outgoing
       ├─ frontend (static Next.js export served by nginx — no Node runtime)
       ├─ db (Postgres 16) + redis + qdrant
       └─ uploads volume (local EBS)

Docker images: Docker Hub — single repo, one tag per service (`chatcenter:auth-<sha>`, `chatcenter:ai-<sha>`, …)
Backups: nightly pg_dump + uploads tar → S3, daily EBS snapshots via DLM (7-day retention)
Secrets: SSM Parameter Store (SecureString)
Shell access: SSH (your key) OR SSM Session Manager (zero open ports)
```

---

## 🧰 Prerequisites (one-time, on your laptop)

| Tool | Install |
|---|---|
| Terraform ≥ 1.5 | `brew install terraform` / [hashicorp.com](https://developer.hashicorp.com/terraform/install) |
| AWS CLI v2 | `brew install awscli` / `apt-get install awscli` |
| Docker + buildx | `brew install docker` + `docker buildx create --use`. On Ubuntu: `sudo apt-get install docker-buildx-plugin` (buildx isn't bundled). |
| `jq` | `brew install jq` / `apt-get install jq` |
| SSM Session Manager plugin (optional) | `brew install --cask session-manager-plugin` |
| Docker Hub account | https://hub.docker.com — **one repo** holds everything (each service is a separate tag). Free plan is enough. |
| Cloudflare account | with your domain |
| AWS account | with root login |

---

## Step 1 — Give Terraform AWS permissions

### 1.1 Create an IAM user (AWS Console)

**IAM → Users → Create user**

| Field | Value |
|---|---|
| User name | `terraform-chatcenter` |
| Console access | **No** (CLI-only) |
| Permissions option | **Attach policies directly** |

### 1.2 Attach permissions — pick A or B

**Option A — Simple (recommended for your stage)**
- ✅ `PowerUserAccess` (AWS-managed)
- ✅ `IAMFullAccess` (AWS-managed, needed because PowerUser doesn't include IAM)

**Option B — Tightly scoped** (production-correct)

Click **Create inline policy → JSON** and paste:

<details>
<summary>Scoped Terraform policy</summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2Full",
      "Effect": "Allow",
      "Action": ["ec2:*"],
      "Resource": "*"
    },
    {
      "Sid": "S3BucketManagement",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket", "s3:DeleteBucket", "s3:ListBucket",
        "s3:GetBucket*", "s3:PutBucket*", "s3:DeleteBucketPolicy",
        "s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration",
        "s3:GetEncryptionConfiguration", "s3:PutEncryptionConfiguration",
        "s3:GetBucketVersioning", "s3:PutBucketVersioning",
        "s3:GetBucketPublicAccessBlock", "s3:PutBucketPublicAccessBlock",
        "s3:GetBucketTagging", "s3:PutBucketTagging"
      ],
      "Resource": [
        "arn:aws:s3:::chatcenter-*",
        "arn:aws:s3:::chatcenter-*/*"
      ]
    },
    {
      "Sid": "IAMRolesForChatCenter",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:ListRoles",
        "iam:UpdateAssumeRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:ListAttachedRolePolicies", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:GetRolePolicy", "iam:ListRolePolicies",
        "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile",
        "iam:PassRole", "iam:TagRole", "iam:UntagRole",
        "iam:ListInstanceProfilesForRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/chatcenter-*",
        "arn:aws:iam::*:instance-profile/chatcenter-*"
      ]
    },
    {
      "Sid": "CloudWatchAlarms",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:DescribeAlarms", "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms", "cloudwatch:ListTagsForResource",
        "cloudwatch:TagResource", "cloudwatch:UntagResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DLMSnapshots",
      "Effect": "Allow",
      "Action": [
        "dlm:CreateLifecyclePolicy", "dlm:DeleteLifecyclePolicy",
        "dlm:GetLifecyclePolicy", "dlm:GetLifecyclePolicies",
        "dlm:UpdateLifecyclePolicy", "dlm:TagResource", "dlm:UntagResource",
        "dlm:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SSMRead",
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeParameters", "ssm:GetParameter", "ssm:GetParameters"
      ],
      "Resource": "*"
    }
  ]
}
```

Name it `chatcenter-terraform-policy`.

</details>

### 1.3 Create access key

User → **Security credentials** → **Create access key** → use case **Command Line Interface (CLI)** → Create.

⚠️ Copy both **Access key ID** + **Secret access key** — you'll never see the secret again.

### 1.4 Configure your laptop

```bash
aws configure --profile chatcenter
# AWS Access Key ID:     AKIA...
# AWS Secret Access Key: ********
# Default region name:   us-east-1
# Default output format: json

export AWS_PROFILE=chatcenter
# Add to ~/.bashrc or ~/.zshrc to make permanent

# Verify
aws sts get-caller-identity
# expect: Account + Arn ending in user/terraform-chatcenter
```

---

## Step 2 — Provision AWS infra with Terraform

```bash
cd /home/ocs/projects/ChatCenter/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` — pick your SSH option:

```hcl
# (A) RECOMMENDED — Terraform creates the AWS key pair from your local public key
ssh_public_key_path = "~/.ssh/id_ed25519.pub"
allowed_ssh_cidrs   = ["1.2.3.4/32"]   # find with: curl -4 ifconfig.me

# (C) NO SSH — rely on SSM Session Manager (leave above commented out)
```

No SSH key yet?
```bash
ssh-keygen -t ed25519 -C "you@example.com"
# Press Enter at all prompts. Then point ssh_public_key_path at ~/.ssh/id_ed25519.pub.
```

Apply:
```bash
terraform init
terraform plan
terraform apply
```

Save the outputs:
```bash
terraform output                          # see everything
terraform output -raw instance_id         # for SSM shell-in
terraform output -raw instance_public_ip  # for SSH
terraform output -raw backup_bucket       # S3 backups bucket
```

**Provisioned:** 1 EC2 t4g.large + 100GB gp3, IAM role, S3 bucket (lifecycle: IA@30d, expire@90d), DLM daily snapshots, 3 CloudWatch alarms, security group (outbound open).

---

## Step 3 — Set up Docker Hub

### 3.1 Create an access token

https://app.docker.com/settings/personal-access-tokens → **New Access Token** → Read & Write → save the token (`dckr_pat_...`).

### 3.2 Store the token in SSM (so the EC2 can pull private images)

From your laptop:

```bash
aws ssm put-parameter \
  --name "/chatcenter/prod/DOCKERHUB_USERNAME" \
  --type "String" \
  --value "<your-dockerhub-username>" \
  --region us-east-1

aws ssm put-parameter \
  --name "/chatcenter/prod/DOCKERHUB_TOKEN" \
  --type "SecureString" \
  --value "dckr_pat_xxxxx" \
  --region us-east-1
```

The EC2 IAM role already has read access to `/chatcenter/prod/*`.

> **Public images?** Skip 3.2 — no login needed on the EC2.

---

## Step 4 — Build & push images to Docker Hub

All images go into **one Docker Hub repo**. Each service becomes a tag inside that repo:
`docker.io/<you>/<repo>:auth-<sha>`, `…:ai-<sha>`, `…:frontend-<sha>`, plus a rolling `<svc>-latest`.

On your **local machine**:

```bash
cd /home/ocs/projects/ChatCenter

# Login (token from Step 3.1)
echo "dckr_pat_xxxxx" | docker login -u <your-dockerhub-username> --password-stdin

# Required env
export REGISTRY=docker.io/<your-dockerhub-username>   # registry host + namespace
export REPO=chatcenter                                # the ONE repo to push everything into
export PLATFORM=linux/arm64                           # ⚠️ t4g.large is ARM — match it!
export TAG=$(git rev-parse --short HEAD)              # or v1.0.0

# Frontend build-args (baked into the static export at build time)
export NEXT_PUBLIC_API_URL=https://app.yourdomain.com
export NEXT_PUBLIC_WS_URL=wss://app.yourdomain.com
export NEXT_PUBLIC_META_APP_ID=...
export NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=...

# Build + push EVERYTHING (10 backend services + static-nginx frontend)
./scripts/docker-publish.sh
```

After it finishes you'll have, in one repo, tag pairs like:
`auth-a1b2c3d` + `auth-latest`, `ai-a1b2c3d` + `ai-latest`, …, `frontend-a1b2c3d` + `frontend-latest`.

**Subset / variations:**
```bash
SERVICES=ai,frontend ./scripts/docker-publish.sh       # just two services
TAG=v0.1.0 ./scripts/docker-publish.sh                  # pin a version tag
PLATFORM=linux/arm64,linux/amd64 ./scripts/docker-publish.sh   # multi-arch (~2× build time)
```

⚠️ `linux/arm64` is essential — the EC2 is Graviton (t4g.*). Without it: `exec format error` on the box.

---

## Step 5 — Shell into the EC2

### Option A — SSH

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@$(terraform -chdir=terraform output -raw instance_public_ip)
# or just:
$(terraform -chdir=terraform output -raw ssh_command)
```

### Option B — SSM Session Manager (no keys, no open ports)

```bash
aws ssm start-session --target $(terraform -chdir=terraform output -raw instance_id) --region us-east-1
sudo -u ubuntu -i
```

### Wait for cloud-init to finish

```bash
tail -f /var/log/chatcenter-bootstrap.log
# wait for: "[bootstrap] done at ..."
```

This installs Docker, the CloudWatch agent, cloudflared, and the nightly backup cron.

### Log in to Docker Hub from EC2 (private images only)

```bash
DH_USER=$(aws ssm get-parameter --name /chatcenter/prod/DOCKERHUB_USERNAME --region us-east-1 --query 'Parameter.Value' --output text)
DH_TOKEN=$(aws ssm get-parameter --name /chatcenter/prod/DOCKERHUB_TOKEN --with-decryption --region us-east-1 --query 'Parameter.Value' --output text)
echo "$DH_TOKEN" | docker login -u "$DH_USER" --password-stdin
```

That writes `~/.docker/config.json` — persistent across reboots.

---

## Step 6 — Clone the app + write `.env`

On the EC2:

```bash
sudo chown -R ubuntu:ubuntu /opt/chatcenter
cd /opt/chatcenter
git clone <your-repo-url> .

cp .env.example .env
nano .env
```

Required values in `.env`:

```bash
# Registry — what you pushed in Step 4
REGISTRY=docker.io/<your-dockerhub-username>
REPO=chatcenter
TAG=<the tag you pushed>

# Database
POSTGRES_PASSWORD=$(openssl rand -hex 16)
DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/whatsapp_cc

# Security (generate fresh — never reuse dev values)
JWT_SECRET=$(openssl rand -hex 32)
CHANNEL_ENCRYPTION_KEY=$(openssl rand -hex 32)
INTERNAL_SERVICE_KEY=$(openssl rand -hex 32)
SYSTEM_ADMIN_SETUP_SECRET=$(openssl rand -hex 32)

# External APIs
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...
META_APP_ID=...
META_APP_SECRET=...
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
WHATSAPP_APP_SECRET=...

# URLs (must match Cloudflare DNS)
FRONTEND_URL=https://app.yourdomain.com
PUBLIC_BASE_URL=https://app.yourdomain.com
NEXT_PUBLIC_API_URL=https://app.yourdomain.com
WEBHOOK_URL=https://app.yourdomain.com
OAUTH_REDIRECT_URI=https://app.yourdomain.com/api/channels/oauth/callback
```

> 💡 You can also pull most of these from SSM Parameter Store. Put them there with `aws ssm put-parameter --type SecureString ...` and add a small bootstrap step that fetches them at boot.

---

## Step 7 — Wire up Cloudflare Tunnel

```bash
cloudflared tunnel login                                  # opens browser auth URL — open it
cloudflared tunnel create prod
cloudflared tunnel route dns prod app.yourdomain.com
cloudflared tunnel route dns prod voice.yourdomain.com    # for Twilio Media Streams

TUNNEL_ID=$(cloudflared tunnel list -o json | jq -r '.[] | select(.name=="prod") | .id')

sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml >/dev/null <<YAML
tunnel: prod
credentials-file: /root/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: voice.yourdomain.com
    service: http://localhost:4007
    originRequest:
      noTLSVerify: true
      connectTimeout: 10s
  - hostname: app.yourdomain.com
    service: http://localhost:80
  - service: http_status:404
YAML

sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl status cloudflared       # should be "active (running)"
```

Why a dedicated `voice.` subdomain → skips nginx, lower WSS latency for Twilio Media Streams.

---

## Step 8 — Start the app

```bash
cd /opt/chatcenter
docker compose -f docker-compose.prod.yml pull

# Run DB migrations (one-shot, on-demand)
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate

# Start everything
docker compose -f docker-compose.prod.yml up -d

# Verify all services healthy
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f --tail=50
```

---

## Step 9 — Verify

```bash
# From your laptop — health endpoint via Cloudflare
curl -i https://app.yourdomain.com/health
# expect: 200 + {"status":"ok","service":"gateway"}

# Open the app
open https://app.yourdomain.com
```

Then in the AWS Console: check **CloudWatch → Alarms** — should be 3 alarms in `OK` state.

---

## 🔄 Future deploys

Once the box is running, future deploys are 2 steps:

### Local — build + push
```bash
export REGISTRY=docker.io/<user>
export REPO=chatcenter
export PLATFORM=linux/arm64
export TAG=$(git rev-parse --short HEAD)
docker login
./scripts/docker-publish.sh                  # all services + frontend
# or just what changed:
SERVICES=ai,frontend ./scripts/docker-publish.sh
```

### EC2 — pull + restart
```bash
ssh / ssm into box
cd /opt/chatcenter
sed -i "s/^TAG=.*/TAG=$NEW_TAG/" .env       # or keep using :latest with pull_policy: always
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
docker compose -f docker-compose.prod.yml up -d
```

> Want to automate this? Add `.github/workflows/deploy.yml` that builds on `push to main` and SSMs into the box to pull + restart. Ask and I'll generate it.

---

## 🆘 Routine ops

| Action | Command |
|---|---|
| Shell into the box | `aws ssm start-session --target $(terraform output -raw instance_id)` |
| Tail backup log | `tail -f /var/log/chatcenter-backup.log` |
| Manually back up now | `sudo /usr/local/bin/chatcenter-backup.sh` |
| List S3 backups | `aws s3 ls s3://$(terraform output -raw backup_bucket)/db/` |
| Restore latest DB | `aws s3 cp s3://<bucket>/db/<date>.sql.gz - \| gunzip \| docker compose -f docker-compose.prod.yml exec -T db psql -U postgres whatsapp_cc` |
| List EBS snapshots | `aws ec2 describe-snapshots --owner-ids self --filters Name=tag:Snapshot,Values=daily` |
| Restart one service | `docker compose -f docker-compose.prod.yml restart ai` |
| View service logs | `docker compose -f docker-compose.prod.yml logs -f ai` |
| Check disk usage | `df -h /` |

---

## 🐛 Common gotchas

| Symptom | Fix |
|---|---|
| `pull access denied` on private image | `docker login` on EC2 was never run, or token expired. Re-run the SSM-fetch + `docker login` block from Step 5. |
| `toomanyrequests` from Docker Hub | Free tier limits anonymous pulls. Login fixes it (200/6h authed; unlimited on Pro). |
| `exec format error` | Image built for amd64. Rebuild with `PLATFORM=linux/arm64 ./scripts/docker-publish.sh`. |
| `unknown flag: --name` when running publish script | Buildx plugin not installed. `sudo apt-get install docker-buildx-plugin` then re-run. |
| `invalid reference format` pushing image | `REGISTRY` includes the repo name (e.g. `omerserruya/chatcenter`). It should be only `docker.io/omerserruya`; the repo goes in `REPO`. |
| `cloudflared` won't connect | `sudo journalctl -u cloudflared -f` — usually wrong tunnel ID in `config.yml`. |
| Frontend shows wrong API URL | `NEXT_PUBLIC_*` is baked at build time. Rebuild + push the frontend image with the right `--build-arg`. |
| `voice.yourdomain.com` drops mid-call | Cloudflare proxy WSS sometimes flakes on Twilio. Set `voice.` to **DNS-only (grey cloud)**, keep `app.` proxied. |
| Postgres OOM-killed | The 2GB swap in `user_data.sh` usually catches this. If recurring → bump to `t4g.xlarge` ($98/mo) or split Postgres to RDS. |
| `terraform apply` errors with `AccessDenied` | Your IAM user's policy is missing an action. Re-attach `PowerUserAccess` + `IAMFullAccess`, or add the missing action to the scoped JSON. |

---

## 💾 Backups & recovery

**What's backed up:**
- **Postgres** → nightly `pg_dump` to `s3://<bucket>/db/db-YYYY-MM-DD.sql.gz` (02:30 UTC)
- **Uploads volume** → nightly tarball to `s3://<bucket>/uploads/uploads-YYYY-MM-DD.tar.gz`
- **EBS root volume** → daily snapshot via DLM (03:00 UTC), 7-day retention

**Restore DB:**
```bash
LATEST=$(aws s3 ls s3://$(terraform output -raw backup_bucket)/db/ | sort | tail -1 | awk '{print $4}')
aws s3 cp s3://$(terraform output -raw backup_bucket)/db/$LATEST - | gunzip | \
  docker compose -f docker-compose.prod.yml exec -T db psql -U postgres whatsapp_cc
```

**Restore from EBS snapshot:** AWS Console → EC2 → Snapshots → select → **Create Volume** → detach old volume from instance → attach new one.

---

## 💰 Cost summary

| Item | $/mo |
|---|---|
| EC2 t4g.large (on-demand, Month 1) | $49 |
| EBS gp3 100GB | $8 |
| EBS snapshots (7-day) | $3 |
| S3 backups (~30GB) | $1 |
| Egress | $2 |
| Cloudflare / SSM / CloudWatch alarms | $0 |
| **Month 1 total** | **~$63** |
| **After 1-yr Savings Plan** | **~$45** |
| Docker Hub Pro | +$5 |

> Buy the Savings Plan after 30 days. **AWS Console → Cost Management → Savings Plans → Compute → 1-year → No upfront.** Drops EC2 cost ~36%.

---

## 🚦 When to graduate from this setup

Migrate to ECS + RDS + ElastiCache when **any** trigger fires:

| Trigger | Why |
|---|---|
| CPU > 70% sustained for a week | Queuing under load |
| 20+ tenants or 200+ concurrent agents | Single box gets noisy |
| Zero-downtime deploys become a hard SLA | docker compose restart = 30–60s outage |
| Uploads volume > 50 GB | S3 is 10× cheaper at that size |
| Geo-redundancy / multi-region sold | Single AZ won't cut it |
| Compliance: RPO < 24h or HA required | Need Multi-AZ RDS |

The migration path is clean because your services are already stateless — only the stateful trio (Postgres → RDS, Redis → ElastiCache, Qdrant → bigger box) needs to move out.

---

## 📁 Files referenced in this guide

| Path | Purpose |
|---|---|
| `terraform/` | AWS infrastructure as code |
| `terraform/terraform.tfvars.example` | Variable template |
| `terraform/README.md` | Quick Terraform reference |
| `docker-compose.prod.yml` | Production compose (pulls images, no builds) |
| `.env.example` | Environment variable template |
| `nginx/nginx.conf.template` | Gateway routing rules |
| `scripts/docker-publish.sh` | One-shot: build + push every service to Docker Hub |
| `frontend/Dockerfile` | Multi-stage: Next.js static export → nginx:alpine |
| `frontend/nginx-frontend.conf` | SPA fallback for client-side dynamic routes |

---

## 🆘 Need help?

- Terraform errors → `terraform plan` first; the error usually tells you exactly which IAM permission is missing
- App errors → `docker compose -f docker-compose.prod.yml logs -f <service-name>`
- Cloudflare errors → `sudo journalctl -u cloudflared -f`
- Backup didn't run → `cat /var/log/chatcenter-backup.log`

---

**TL;DR — first deploy timing:**

| Phase | Time |
|---|---|
| IAM user setup | 5 min |
| `terraform apply` | 3 min |
| Build + push 11 images (`./scripts/docker-publish.sh`) | 10–20 min |
| Cloud-init + clone + .env + tunnel | 10 min |
| App pull + migrate + up | 5 min |
| **Total** | **~30–45 min** |
