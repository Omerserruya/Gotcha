-- Short-lived, revocable continuation links for paid-tenant onboarding.
-- Purely additive. Hand-written: generated diff also emits unrelated dev drift.

CREATE TYPE "ContinuationLinkPurpose" AS ENUM ('PAID_TENANT_ONBOARDING');

CREATE TABLE "payment_continuation_links" (
  "id"          TEXT NOT NULL,
  "checkout_id" TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  -- Only the SHA-256 hash. The raw token is never stored, so a database dump
  -- cannot reconstruct a working link.
  "token_hash"  TEXT NOT NULL,
  "purpose"     "ContinuationLinkPurpose" NOT NULL DEFAULT 'PAID_TENANT_ONBOARDING',
  "expires_at"  TIMESTAMP(3) NOT NULL,
  "used_at"     TIMESTAMP(3),
  "revoked_at"  TIMESTAMP(3),
  "created_by"  TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_continuation_links_pkey" PRIMARY KEY ("id")
);

-- Unique so lookup is one indexed probe rather than a scan (no timing signal
-- from how many rows were examined), and so two links cannot collide.
CREATE UNIQUE INDEX "payment_continuation_links_token_hash_key"
  ON "payment_continuation_links"("token_hash");
CREATE INDEX "payment_continuation_links_checkout_id_idx" ON "payment_continuation_links"("checkout_id");
CREATE INDEX "payment_continuation_links_tenant_id_idx"   ON "payment_continuation_links"("tenant_id");
CREATE INDEX "payment_continuation_links_expires_at_idx"  ON "payment_continuation_links"("expires_at");

ALTER TABLE "payment_continuation_links"
  ADD CONSTRAINT "payment_continuation_links_checkout_id_fkey"
  FOREIGN KEY ("checkout_id") REFERENCES "pending_checkouts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
