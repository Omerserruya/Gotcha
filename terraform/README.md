# ChatCenter - AWS Terraform (Single EC2, Phase 1)

Lean, single-EC2 deployment for 5–7 tenants. ~$45/mo after 30 days of on-demand pricing.

## What this creates

| Resource | Why |
|---|---|
| 1× EC2 `t4g.large` (Ubuntu 22.04 ARM) + 100GB gp3 | Runs the full `docker-compose.yml` stack |
| IAM instance role | S3 backups, SSM secret reads, SSM Session Manager, CloudWatch agent |
| Security group | All outbound; SSH only if you set `allowed_ssh_cidrs` |
| S3 backups bucket | Nightly pg_dump + uploads tarball, lifecycle to IA at 30d, expire at 90d |
| DLM policy | Daily EBS snapshots, 7-day retention |
| 3 CloudWatch alarms | CPU > 70%, disk > 80%, status check failed |
| (Optional) Elastic IP | Off by default - Cloudflare Tunnel doesn't need it |

## What this does NOT do (intentional)

- Doesn't clone your repo
- Doesn't write `.env`
- Doesn't start `docker compose`
- Doesn't register the Cloudflare tunnel
- Doesn't create SSM secret values (manual - keeps secrets out of TF state)

You do those by hand after the box is up (see "After apply" below).

---

## Prereqs

- Terraform `>= 1.5`
- AWS account + `aws configure` done (or `AWS_PROFILE` set)
- (Optional) An EC2 key pair if you want SSH. Otherwise use SSM Session Manager.
- A Cloudflare account with your domain on it.

## Deploy

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars if you want to change region/instance size

terraform init
terraform plan
terraform apply
```

Apply takes ~3 min. Outputs include the instance ID, the S3 bucket name, and the `aws ssm` command to shell in.

## After apply - wire up the app

### 1. Shell into the box - three options

#### Option A - SSH with your local key (recommended for daily use)

In `terraform.tfvars`:
```hcl
ssh_public_key_path = "~/.ssh/id_ed25519.pub"  # whatever public key you have
allowed_ssh_cidrs   = ["1.2.3.4/32"]           # your current IP - `curl -4 ifconfig.me`
```

`terraform apply`, then:
```bash
# The output prints the exact command:
terraform output -raw ssh_command
# e.g.:
ssh -i ~/.ssh/id_ed25519 ubuntu@<public-ip>
```

Don't have an SSH key yet? Make one in 5 seconds:
```bash
ssh-keygen -t ed25519 -C "you@example.com"
# Just press Enter at the prompts. Then point ssh_public_key_path at
# ~/.ssh/id_ed25519.pub
```

#### Option B - SSM Session Manager (zero open ports, no key needed)

The instance role already grants SSM access. From your laptop:
```bash
# One-time: install the SSM plugin
brew install --cask session-manager-plugin   # macOS
# OR
sudo apt-get install -y session-manager-plugin   # Ubuntu/Debian

aws ssm start-session --target $(terraform output -raw instance_id) --region us-east-1
sudo -u ubuntu -i
```

Use this when you don't want to manage SSH keys, leave port 22 open, or
share access across teammates without distributing keys.

#### Option C - Reuse an existing AWS key pair

If you already created a key pair in the AWS Console, set `key_pair_name`
in `terraform.tfvars` and skip `ssh_public_key_path`.

### 2. Wait for cloud-init to finish

```bash
tail -f /var/log/chatcenter-bootstrap.log
# look for "[bootstrap] done at ..."
```

This installs Docker, the CloudWatch agent, cloudflared, and the nightly backup cron.

### 3. Clone the repo + write `.env`

```bash
cd /opt/chatcenter
git clone <your-repo-url> .

# .env: fetch values from SSM Parameter Store (you put them there, see step 4)
# Quick approach: copy .env.example, fill in OPENAI_API_KEY, JWT_SECRET, etc.
cp .env.example .env
nano .env
```

### 4. Put long-lived secrets in SSM (one-time)

Don't paste secrets into `.env` on disk if you can help it. Put them in SSM and bake a small fetch step into your app start:

```bash
aws ssm put-parameter \
  --name "/chatcenter/prod/JWT_SECRET" \
  --type "SecureString" \
  --value "$(openssl rand -hex 32)" \
  --region us-east-1

aws ssm put-parameter \
  --name "/chatcenter/prod/CHANNEL_ENCRYPTION_KEY" \
  --type "SecureString" \
  --value "$(openssl rand -hex 32)" \
  --region us-east-1

aws ssm put-parameter \
  --name "/chatcenter/prod/OPENAI_API_KEY" \
  --type "SecureString" \
  --value "sk-..." \
  --region us-east-1
# ... and so on for META_APP_SECRET, DEEPGRAM_API_KEY, TWILIO_AUTH_TOKEN, etc.
```

The instance role already has read access to `/chatcenter/prod/*`. Fetch them at boot:

```bash
# Inside /opt/chatcenter, write a tiny helper:
aws ssm get-parameters-by-path \
  --path "/chatcenter/prod/" \
  --with-decryption \
  --query "Parameters[].[Name,Value]" \
  --output text \
  --region us-east-1 \
  | awk -F'\t' '{ split($1,a,"/"); print a[length(a)] "=" $2 }' \
  > .env.ssm
```

Source `.env.ssm` from your start scripts or merge into `.env`.

### 5. Register the Cloudflare tunnel

```bash
cloudflared tunnel login              # opens browser-auth URL
cloudflared tunnel create prod
cloudflared tunnel route dns prod app.yourdomain.com

# (Optional) dedicated subdomain for Twilio Media Streams - skips nginx,
# lower latency:
cloudflared tunnel route dns prod voice.yourdomain.com

sudo tee /etc/cloudflared/config.yml >/dev/null <<'YAML'
tunnel: prod
credentials-file: /root/.cloudflared/<tunnel-id>.json
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
```

### 6. Start the app

```bash
cd /opt/chatcenter
docker compose pull
docker compose --profile migrate run --rm migrate
docker compose up -d
```

## Routine ops

| Action | Command |
|---|---|
| Shell into the box | `aws ssm start-session --target $(terraform output -raw instance_id)` |
| Tail backup log | `tail -f /var/log/chatcenter-backup.log` |
| Manually back up now | `sudo /usr/local/bin/chatcenter-backup.sh` |
| List S3 backups | `aws s3 ls s3://$(terraform output -raw backup_bucket)/db/` |
| Restore latest DB | `aws s3 cp s3://<bucket>/db/<date>.sql.gz - \| gunzip \| docker compose exec -T db psql -U postgres whatsapp_cc` |
| List EBS snapshots | `aws ec2 describe-snapshots --owner-ids self --filters Name=tag:Snapshot,Values=daily` |

## Cost

| Item | $/mo |
|---|---|
| EC2 t4g.large (on-demand) | $49 |
| EBS gp3 100GB | $8 |
| EBS snapshots (7-day retention) | $3 |
| S3 backups (~30GB) | $1 |
| Egress | $2 |
| **Month 1 total** | **~$63** |
| **After 1-yr Savings Plan** | **~$45** |

> Buy the Savings Plan after 30 days of running, once you've confirmed `t4g.large` is the right size. AWS Console → Cost Management → Savings Plans → Compute, 1-year, no upfront.

## Tear down

```bash
terraform destroy
```

⚠️ This will fail if `backup_bucket_force_destroy = false` and the bucket has objects. That's the intended safety. To wipe:

```bash
aws s3 rm s3://$(terraform output -raw backup_bucket) --recursive
terraform destroy
```

Or set `backup_bucket_force_destroy = true` in `terraform.tfvars` first (NOT recommended in prod).

## When to graduate from this setup

Move to ECS + RDS + ElastiCache when **any** of these fire:

- CPU > 70% sustained for a week
- 20+ tenants or 200+ concurrent agents
- Zero-downtime deploys become a hard SLA requirement
- Uploads volume > 50 GB (S3 becomes 10× cheaper than EBS at that point)
- Need multi-region / multi-AZ failover
