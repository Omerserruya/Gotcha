provider "aws" {
  region = var.region

  default_tags {
    tags = merge(
      {
        Project   = var.project
        Env       = var.env
        ManagedBy = "terraform"
      },
      var.tags,
    )
  }
}

locals {
  name_prefix = "${var.project}-${var.env}"
}

# ── Default VPC / first AZ ────────────────────────────────────────────
# Single-EC2 stage doesn't need a custom VPC. Using the default VPC keeps
# the resource count down and avoids NAT/IGW spend. When you migrate to
# ECS, swap to a dedicated VPC.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Latest Ubuntu 22.04 ARM64 AMI from Canonical (owner 099720109477).
data "aws_ami" "ubuntu_arm" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ── Security group ────────────────────────────────────────────────────
# Outbound: open (Cloudflare Tunnel + Meta/Twilio/OpenAI calls).
# Inbound: SSH only if explicitly allowed. No 80/443 - Cloudflare Tunnel
# is the public entrypoint, dialing OUT from the box.

resource "aws_security_group" "instance" {
  name        = "${local.name_prefix}-ec2"
  description = "ChatCenter single-EC2: outbound open, inbound only conditional SSH."
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = length(var.allowed_ssh_cidrs) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.allowed_ssh_cidrs
    }
  }

  tags = { Name = "${local.name_prefix}-ec2" }
}
