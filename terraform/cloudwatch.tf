# ── Daily EBS snapshots via Data Lifecycle Manager ────────────────────
# DLM is the managed, free way to do scheduled snapshots. Targets any
# volume tagged `Snapshot = "daily"` — the root volume in ec2.tf carries
# that tag, so any extra data volumes added later are picked up
# automatically once tagged.

resource "aws_dlm_lifecycle_policy" "daily" {
  description        = "${local.name_prefix} daily EBS snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags = {
      Snapshot = "daily"
    }

    schedule {
      name = "daily-${var.snapshot_retention_days}d"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"] # UTC — pick a low-traffic hour
      }

      retain_rule {
        count = var.snapshot_retention_days
      }

      copy_tags = true
    }
  }
}

# ── CloudWatch alarms ─────────────────────────────────────────────────
# Three cheap alarms that catch the three things that kill a single-EC2
# setup: CPU pegged, disk full, instance dead. Free-tier covers <=10
# alarms, so this fits.

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${local.name_prefix}-cpu-high"
  alarm_description   = "EC2 CPU > 70% for 15min — sustained load; consider sizing up."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 70
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.app.id
  }
}

resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${local.name_prefix}-status-check-failed"
  alarm_description   = "Instance failed status check — likely needs reboot or restore."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "breaching"

  dimensions = {
    InstanceId = aws_instance.app.id
  }
}

# Disk alarm requires the CloudWatch agent to push `disk_used_percent`.
# user_data installs + configures the agent (see user_data.sh).
resource "aws_cloudwatch_metric_alarm" "disk_high" {
  alarm_name          = "${local.name_prefix}-disk-high"
  alarm_description   = "Root filesystem > 80% — EBS gp3 is filling; prune Docker / extend volume."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "disk_used_percent"
  namespace           = "CWAgent"
  period              = 300
  statistic           = "Maximum"
  threshold           = 80
  treat_missing_data  = "notBreaching" # if agent not running, don't page

  dimensions = {
    InstanceId = aws_instance.app.id
    path       = "/"
    device     = "nvme0n1p1"
    fstype     = "ext4"
  }
}
