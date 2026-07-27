-- Hosted-page tokenization sessions.
--
-- baseline_fingerprints is the load-bearing column: it records which cards the
-- provider already held before the customer was sent anywhere, so afterwards we
-- can tell a NEWLY stored card from one that was already on file. Checking only
-- that "a card exists" would let a stale session, or a customer with a previous
-- card, look like a completed payment setup.
CREATE TYPE "TokenizationSessionStatus" AS ENUM (
  'PENDING', 'AWAITING_RETURN', 'VERIFIED', 'FAILED', 'EXPIRED', 'ABANDONED'
);

CREATE TABLE "tokenization_sessions" (
  "id"                     TEXT NOT NULL,
  "tenant_id"              TEXT NOT NULL,
  "checkout_id"            TEXT,
  "custom_client_id"       TEXT NOT NULL,
  "provider_client_id"     TEXT,
  "page_id"                TEXT NOT NULL,
  "status"                 "TokenizationSessionStatus" NOT NULL DEFAULT 'PENDING',
  "baseline_fingerprints"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "resolved_fingerprint"   TEXT,
  "payment_method_id"      TEXT,
  "verification_attempts"  INTEGER NOT NULL DEFAULT 0,
  "last_verified_at"       TIMESTAMP(3),
  "failure_reason"         TEXT,
  "expires_at"             TIMESTAMP(3) NOT NULL,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tokenization_sessions_pkey" PRIMARY KEY ("id")
);

-- The reference is what correlates a returning customer to their session, so a
-- collision would attribute one customer's card to another.
CREATE UNIQUE INDEX "tokenization_sessions_custom_client_id_key"
  ON "tokenization_sessions"("custom_client_id");
CREATE INDEX "tokenization_sessions_tenant_id_idx"   ON "tokenization_sessions"("tenant_id");
CREATE INDEX "tokenization_sessions_checkout_id_idx" ON "tokenization_sessions"("checkout_id");
CREATE INDEX "tokenization_sessions_status_expires_idx"
  ON "tokenization_sessions"("status", "expires_at");
