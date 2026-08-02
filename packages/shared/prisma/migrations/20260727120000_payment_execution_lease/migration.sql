-- Cross-instance payment execution safety + payment-token encryption metadata.
-- Purely additive. Hand-written: generated diff also emits unrelated dev drift.

-- A lease that expired after a provider request may have been submitted is NOT
-- the same as a failure. It gets its own state so it can never be confused with
-- one that is safe to retry.
ALTER TYPE "PaymentAttemptState" ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';

-- Execution ownership. The unique attempt_key stops two ROWS existing; these
-- stop two WORKERS executing the same row.
ALTER TABLE "payment_attempts"
  ADD COLUMN IF NOT EXISTS "execution_owner"              TEXT,
  ADD COLUMN IF NOT EXISTS "execution_lease_expires_at"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "execution_started_at"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempt_number"               INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "provider_request_started_at"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "provider_response_received_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "payment_attempts_execution_lease_expires_at_idx"
  ON "payment_attempts"("execution_lease_expires_at");

-- Which key encrypted this token, so rotation does not orphan existing rows.
ALTER TABLE "payment_methods"
  ADD COLUMN IF NOT EXISTS "token_key_version" TEXT;

-- A tenant provisioned on a paid plan whose first payment is not yet verified.
ALTER TYPE "TenantStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
