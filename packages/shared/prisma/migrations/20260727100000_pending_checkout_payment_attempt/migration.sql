-- Provider-independent checkout + payment-attempt infrastructure.
--
-- Purely additive: two new enums, two new tables, no changes to existing
-- objects. Hand-written rather than generated because `prisma migrate diff`
-- against this dev database also emits unrelated drift.

CREATE TYPE "CheckoutStatus" AS ENUM (
  'PENDING', 'AWAITING_PROVIDER', 'TOKENIZED', 'PAID', 'EXPIRED', 'CANCELED', 'FAILED'
);

CREATE TYPE "PaymentAttemptState" AS ENUM (
  'PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'MANUAL_REVIEW'
);

CREATE TABLE "pending_checkouts" (
  "id"                        TEXT NOT NULL,
  "reference"                 TEXT NOT NULL,
  "tenant_id"                 TEXT,
  "signup_context"            JSONB,
  "plan_key"                  TEXT NOT NULL,
  "plan_version"              INTEGER NOT NULL,
  "chat_volume_option_key"    TEXT,
  "voice_volume_option_key"   TEXT,
  "snapshot_price"            DECIMAL(12,2) NOT NULL,
  "snapshot_currency"         TEXT NOT NULL,
  "snapshot_included_credits" INTEGER NOT NULL,
  "amount"                    DECIMAL(12,2) NOT NULL,
  "currency"                  TEXT NOT NULL,
  "trial_behavior"            TEXT NOT NULL DEFAULT 'none',
  "status"                    "CheckoutStatus" NOT NULL DEFAULT 'PENDING',
  "expires_at"                TIMESTAMP(3) NOT NULL,
  "idempotency_key"           TEXT NOT NULL,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pending_checkouts_pkey" PRIMARY KEY ("id")
);

-- The opaque reference and the charge idempotency key are both globally unique:
-- a replayed callback must not be able to create a second checkout or a second
-- charge.
CREATE UNIQUE INDEX "pending_checkouts_reference_key" ON "pending_checkouts"("reference");
CREATE UNIQUE INDEX "pending_checkouts_idempotency_key_key" ON "pending_checkouts"("idempotency_key");
CREATE INDEX "pending_checkouts_tenant_id_idx" ON "pending_checkouts"("tenant_id");
CREATE INDEX "pending_checkouts_status_expires_at_idx" ON "pending_checkouts"("status", "expires_at");

CREATE TABLE "payment_attempts" (
  "id"                  TEXT NOT NULL,
  "attempt_key"         TEXT NOT NULL,
  "checkout_id"         TEXT,
  "tenant_id"           TEXT,
  "purpose"             TEXT NOT NULL,
  "amount"              DECIMAL(12,2) NOT NULL,
  "currency"            TEXT NOT NULL,
  "state"               "PaymentAttemptState" NOT NULL DEFAULT 'PENDING',
  "provider_charge_ref" TEXT,
  "failure_code"        TEXT,
  "reconciled_at"       TIMESTAMP(3),
  "candidate_count"     INTEGER,
  "review_reason"       TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- THE double-charge guard. iCount has confirmed no provider-side idempotency
-- mechanism, so this unique index is currently the only thing that makes a
-- retried renewal a database conflict instead of a second charge.
CREATE UNIQUE INDEX "payment_attempts_attempt_key_key" ON "payment_attempts"("attempt_key");
CREATE INDEX "payment_attempts_tenant_id_idx" ON "payment_attempts"("tenant_id");
CREATE INDEX "payment_attempts_state_idx" ON "payment_attempts"("state");
CREATE INDEX "payment_attempts_checkout_id_idx" ON "payment_attempts"("checkout_id");

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_checkout_id_fkey"
  FOREIGN KEY ("checkout_id") REFERENCES "pending_checkouts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
