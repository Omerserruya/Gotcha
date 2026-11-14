-- Account deletion requests (Google Play / App Store "delete your account").
-- A person asks; an operator completes it through the GDPR erasure. No foreign
-- keys: the request is the record that the erasure was asked for and done, and
-- it must outlive the user it erases.
CREATE TABLE "account_deletion_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "workspace_name" TEXT,
    "source" TEXT NOT NULL,
    "identity_id" TEXT,
    "user_id" TEXT,
    "tenant_id" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "token_hash" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "rejected_reason" TEXT,
    "result" JSONB,
    "ip_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_deletion_requests_token_hash_key" ON "account_deletion_requests"("token_hash");
CREATE INDEX "account_deletion_requests_email_idx" ON "account_deletion_requests"("email");
CREATE INDEX "account_deletion_requests_status_idx" ON "account_deletion_requests"("status");
CREATE INDEX "account_deletion_requests_identity_id_idx" ON "account_deletion_requests"("identity_id");
