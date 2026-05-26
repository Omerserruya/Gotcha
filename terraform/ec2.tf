locals {
  user_data = templatefile("${path.module}/user_data.sh", {
    project        = var.project
    env            = var.env
    region         = var.region
    backup_bucket  = aws_s3_bucket.backups.bucket
  })

  # SSH key selection precedence:
  #   1. ssh_public_key_path  → Terraform creates a key pair from the file
  #   2. key_pair_name        → use an existing AWS key pair by name
  #   3. neither              → no SSH key (rely on SSM Session Manager)
  effective_key_name = (
    var.ssh_public_key_path != ""
      ? aws_key_pair.ssh[0].key_name
      : (var.key_pair_name != "" ? var.key_pair_name : null)
  )
}

# Created only when ssh_public_key_path is set. Imports your local public
# key into AWS so you don't have to do it manually in the Console.
resource "aws_key_pair" "ssh" {
  count      = var.ssh_public_key_path != "" ? 1 : 0
  key_name   = "${local.name_prefix}-ssh"
  public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))

  tags = { Name = "${local.name_prefix}-ssh" }
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu_arm.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = local.effective_key_name

  # Hibernation off — t4g doesn't support it on the cheap tier anyway.
  monitoring = false # detailed CW metrics cost extra; basic is enough at this scale

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    iops                  = 3000   # gp3 baseline; free
    throughput            = 125    # gp3 baseline; free
    encrypted             = true
    delete_on_termination = false  # keep data if instance is terminated by mistake
    tags = {
      Name     = "${local.name_prefix}-root"
      Snapshot = "daily"           # picked up by the DLM policy
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2          # 2 = OK for Docker containers that hit IMDS
  }

  user_data                   = local.user_data
  user_data_replace_on_change = false # changing user_data must NOT recreate the instance

  lifecycle {
    ignore_changes = [
      ami,        # don't replace the box when Canonical ships a new AMI
      user_data,  # bootstrap script is one-shot at first boot
    ]
  }

  tags = {
    Name = "${local.name_prefix}-app"
  }
}

# Static IP — only matters if you stop using Cloudflare Tunnel. Free while
# attached to a running instance. Detached EIPs cost ~$3.60/mo, so detach
# or release if you stop the instance long-term. Off by default since the
# typical setup here uses Cloudflare Tunnel (outbound, no inbound IP needed).
resource "aws_eip" "app" {
  count    = var.create_eip ? 1 : 0
  domain   = "vpc"
  instance = aws_instance.app.id

  tags = { Name = "${local.name_prefix}-eip" }
}
