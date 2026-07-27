-- Durable record of a Sysadmin's paid-tenant provisioning REQUEST.
--
-- Tenant creation (auth) and billing provisioning (billing) cannot share a
-- transaction. Without this record a billing failure left the tenant in
-- PENDING_PAYMENT with the requested plan stored nowhere: resend could not
-- recreate the missing checkout and retrying creation hit slug uniqueness.
-- Purely additive; hand-written because generated diff also emits dev drift.

CREATE TYPE "BillingProvisioningState" AS ENUM (
  'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED'
);

CREATE TABLE "tenant_billing_provisioning_requests" (
  "id"                      TEXT NOT NULL,
  "tenant_id"               TEXT NOT NULL,
  "requested_by"            TEXT,
  "mode"                    TEXT NOT NULL DEFAULT 'PAID_PLAN',
  "plan_version_id"         TEXT NOT NULL,
  "chat_volume_option_key"  TEXT,
  "voice_volume_option_key" TEXT,
  "billing_interval"        TEXT,
  "commercial_note"         TEXT,
  "idempotency_key"         TEXT NOT NULL,
  "state"                   "BillingProvisioningState" NOT NULL DEFAULT 'PENDING',
  "checkout_id"             TEXT,
  "attempt_count"           INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at"         TIMESTAMP(3),
  "next_retry_at"           TIMESTAMP(3),
  "last_failure_code"       TEXT,
  "last_failure_message"    TEXT,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"            TIMESTAMP(3),
  CONSTRAINT "tenant_billing_provisioning_requests_pkey" PRIMARY KEY ("id")
);

-- Deterministic key: billing keys the checkout and the initial attempt on it,
-- so any number of retries converge on ONE set of records.
CREATE UNIQUE INDEX "tenant_billing_provisioning_requests_idempotency_key_key"
  ON "tenant_billing_provisioning_requests"("idempotency_key");
CREATE INDEX "tenant_billing_provisioning_requests_tenant_id_idx"
  ON "tenant_billing_provisioning_requests"("tenant_id");
CREATE INDEX "tenant_billing_provisioning_requests_state_next_retry_at_idx"
  ON "tenant_billing_provisioning_requests"("state", "next_retry_at");
