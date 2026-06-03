variable "project" {
  description = "Project tag applied to all resources for cost tracking."
  type        = string
  default     = "chatcenter"
}

variable "env" {
  description = "Environment name (prod, staging). Used in resource names + tags."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "il-central-1"
}

variable "instance_type" {
  description = "EC2 instance type. ARM (t4g.*) is ~20% cheaper than x86 — keep ARM unless an image stops supporting it."
  type        = string
  default     = "t4g.large"
}

variable "root_volume_size_gb" {
  description = "Root EBS gp3 volume size. Postgres + Qdrant + uploads + system all live here."
  type        = number
  default     = 100
}

variable "ssh_public_key_path" {
  description = "Path to your local SSH public key (e.g. ~/.ssh/id_ed25519.pub). When set, Terraform creates the AWS key pair from it and attaches it to the instance. Recommended path — no manual AWS Console steps."
  type        = string
  default     = ""
}

variable "key_pair_name" {
  description = "Use this ONLY if you already have an EC2 Key Pair in AWS and want to reuse it. Leave empty when using ssh_public_key_path (preferred) or when going SSH-less via SSM Session Manager."
  type        = string
  default     = ""
}

variable "allowed_ssh_cidrs" {
  description = "CIDR blocks allowed to SSH (port 22). Set to [\"<your-ip>/32\"] — find your IP with `curl ifconfig.me`. Empty = SG blocks port 22 entirely (use SSM Session Manager instead)."
  type        = list(string)
  default     = []
}

variable "snapshot_retention_days" {
  description = "Daily EBS snapshot retention. 7 days is the default — bump for compliance."
  type        = number
  default     = 7
}

variable "create_eip" {
  description = "Allocate an Elastic IP for the instance. NOT needed when using Cloudflare Tunnel (the tunnel dials out)."
  type        = bool
  default     = false
}

variable "backup_bucket_force_destroy" {
  description = "If true, terraform destroy will wipe the backup bucket too. Keep false in prod."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Additional tags merged into every resource."
  type        = map(string)
  default     = {}
}
