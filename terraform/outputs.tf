output "instance_id" {
  description = "EC2 instance ID - useful for SSM Session Manager."
  value       = aws_instance.app.id
}

output "instance_public_ip" {
  description = "Auto-assigned public IPv4 (default VPC behavior). Use for initial cloudflared install only - don't expose it as a service entrypoint."
  value       = aws_instance.app.public_ip
}

output "instance_private_ip" {
  description = "Private IP of the instance."
  value       = aws_instance.app.private_ip
}

output "elastic_ip" {
  description = "Elastic IP (only set when var.create_eip = true)."
  value       = length(aws_eip.app) > 0 ? aws_eip.app[0].public_ip : null
}

output "backup_bucket" {
  description = "S3 bucket for nightly pg_dump + uploads backup. The instance has read/write access via its IAM role."
  value       = aws_s3_bucket.backups.bucket
}

output "registry_hint" {
  description = "Set REGISTRY in your prod .env to your Docker Hub namespace, e.g. 'docker.io/yourusername' or just 'yourusername'."
  value       = "Configure REGISTRY=<your-dockerhub-username> in .env on the EC2."
}

output "ssm_parameter_prefix" {
  description = "Path prefix for app secrets in SSM Parameter Store. Create SecureString params here; the instance can read them."
  value       = "/${var.project}/${var.env}/"
}

output "ssm_session_command" {
  description = "Shell in via SSM Session Manager - works with NO SSH key + NO open port 22. Requires `aws ssm` plugin (`brew install --cask session-manager-plugin` or apt equivalent)."
  value       = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.region}"
}

output "ssh_command" {
  description = "Native SSH command. Only useful when ssh_public_key_path (or key_pair_name) was set AND your IP is in allowed_ssh_cidrs."
  value = (
    local.effective_key_name == null
      ? "SSH not configured. Set ssh_public_key_path + allowed_ssh_cidrs in terraform.tfvars, OR use ssm_session_command."
      : (
        length(aws_eip.app) > 0
          ? "ssh -i ${var.ssh_public_key_path != "" ? replace(var.ssh_public_key_path, ".pub", "") : "<your-private-key>"} ubuntu@${aws_eip.app[0].public_ip}"
          : "ssh -i ${var.ssh_public_key_path != "" ? replace(var.ssh_public_key_path, ".pub", "") : "<your-private-key>"} ubuntu@${aws_instance.app.public_ip}"
      )
  )
}

output "estimated_monthly_cost_usd" {
  description = "Rough Month-1 on-demand estimate. Buy a 1-yr Savings Plan after 30 days to drop EC2 cost ~36%."
  value       = "~$63 (EC2 $49 + EBS $8 + snapshots $3 + S3 $1 + egress $2). With 1-yr Savings Plan: ~$45/mo."
}
