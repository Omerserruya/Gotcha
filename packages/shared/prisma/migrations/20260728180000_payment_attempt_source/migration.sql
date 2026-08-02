-- Provenance on the payment attempt itself, so billing history can never
-- present a Sysadmin-activated contract as a card payment that cleared.
-- Purely additive.

ALTER TABLE "payment_attempts"
  ADD COLUMN IF NOT EXISTS "payment_source"         TEXT NOT NULL DEFAULT 'PROVIDER_CONFIRMED',
  ADD COLUMN IF NOT EXISTS "external_reference"     TEXT,
  ADD COLUMN IF NOT EXISTS "manual_reason"          TEXT,
  ADD COLUMN IF NOT EXISTS "manual_payment_source"  TEXT;

CREATE INDEX IF NOT EXISTS "payment_attempts_payment_source_idx"
  ON "payment_attempts"("payment_source");
