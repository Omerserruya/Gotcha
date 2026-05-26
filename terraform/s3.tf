# Backups bucket — nightly pg_dump + uploads tarball. Random suffix so the
# name is globally unique without coordination.

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "backups" {
  bucket        = "${local.name_prefix}-backups-${random_id.bucket_suffix.hex}"
  force_destroy = var.backup_bucket_force_destroy
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    # Off — backups are append-only by date; versioning would double storage
    # without saving anything we can't recover via daily files.
    status = "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Lifecycle: after 30 days move to Standard-IA, after 90 days delete.
# Daily snapshots are the primary recovery path; older copies are cold.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "tier-and-expire"
    status = "Enabled"

    filter {} # apply to all objects

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    expiration {
      days = 90
    }

    # Clean up multipart leftovers so they don't accumulate cost.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
