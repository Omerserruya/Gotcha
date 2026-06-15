# Instance role - grants the box: write backups to S3, read SSM secrets,
# push CloudWatch metrics, and SSM Session Manager access (so you can shell
# in without opening port 22).

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name_prefix}-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

# AWS-managed: SSM Session Manager (shell in via console, no SSH key needed).
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# AWS-managed: CloudWatch agent push (custom disk/mem metrics).
resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# NOTE: no ECR policy here - registry is Docker Hub, not ECR. The EC2
# authenticates to Docker Hub via `docker login` at bootstrap time, using
# credentials pulled from SSM Parameter Store.

# Custom: scoped S3 + SSM-read access. NOT the wildcard managed policies -
# this box should only see its own backup bucket + its own SSM namespace.
data "aws_iam_policy_document" "instance_inline" {
  statement {
    sid    = "BackupBucketRW"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:AbortMultipartUpload",
    ]
    resources = [
      aws_s3_bucket.backups.arn,
      "${aws_s3_bucket.backups.arn}/*",
    ]
  }

  statement {
    sid    = "ReadOwnSSMParams"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:aws:ssm:${var.region}:*:parameter/${var.project}/${var.env}/*",
    ]
  }

  statement {
    sid    = "DecryptSecureStrings"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    # The default AWS-managed key for SSM. Avoids a per-tenant CMK at this stage.
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "instance_inline" {
  name   = "${local.name_prefix}-ec2-inline"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_inline.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name_prefix}-ec2-profile"
  role = aws_iam_role.instance.name
}

# ── DLM role (for daily EBS snapshots) ────────────────────────────────

data "aws_iam_policy_document" "dlm_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name_prefix}-dlm-role"
  assume_role_policy = data.aws_iam_policy_document.dlm_trust.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}
