-- Provenance for automatically fetched official exchange rates.
--
-- The rate a customer is charged at now comes from the Bank of Israel rather
-- than from two administrators typing a number. That changes what has to be
-- recorded: not "who approved this" but "which published figure was this, when
-- did they publish it, when did we read it, and until when may we use it".

CREATE TYPE "FxRateOrigin" AS ENUM ('AUTOMATIC_OFFICIAL', 'MANUAL_OVERRIDE', 'EMERGENCY_FALLBACK');
CREATE TYPE "FxVerificationState" AS ENUM ('VERIFIED_OFFICIAL', 'MANUALLY_APPROVED', 'REJECTED');

ALTER TABLE "billing_exchange_rates"
  ADD COLUMN IF NOT EXISTS "origin"             "FxRateOrigin" NOT NULL DEFAULT 'AUTOMATIC_OFFICIAL',
  ADD COLUMN IF NOT EXISTS "verification_state" "FxVerificationState" NOT NULL DEFAULT 'VERIFIED_OFFICIAL',
  ADD COLUMN IF NOT EXISTS "official_date"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retrieved_at"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "raw_response_hash"  TEXT,
  ADD COLUMN IF NOT EXISTS "max_use_until"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "override_reason"    TEXT,
  ADD COLUMN IF NOT EXISTS "override_of_rate_id" TEXT;

-- The default source is now the official feed, not a hand-typed figure.
ALTER TABLE "billing_exchange_rates"
  ALTER COLUMN "source" SET DEFAULT 'BANK_OF_ISRAEL_REPRESENTATIVE';

-- Rows that predate this migration were manual by definition. Marking them
-- AUTOMATIC_OFFICIAL would claim a provenance they never had.
UPDATE "billing_exchange_rates"
   SET "origin" = 'MANUAL_OVERRIDE',
       "verification_state" = 'MANUALLY_APPROVED'
 WHERE "source" <> 'BANK_OF_ISRAEL_REPRESENTATIVE';

-- Finding the newest usable official rate is the hot path: every payment quote
-- asks for it.
CREATE INDEX IF NOT EXISTS "billing_exchange_rates_official_lookup_idx"
  ON "billing_exchange_rates"("base_currency", "quote_currency", "status", "official_date");

-- An automatic rate needs no approver; a manual one is not valid without two
-- distinct people. Enforced here so the rule survives a code path nobody
-- remembered to guard.
ALTER TABLE "billing_exchange_rates"
  ADD CONSTRAINT "billing_exchange_rates_manual_needs_two_people"
  CHECK (
    "origin" = 'AUTOMATIC_OFFICIAL'
    OR "status" <> 'ACTIVE'
    OR ("approved_by" IS NOT NULL AND "created_by" IS NOT NULL AND "approved_by" <> "created_by")
  );
