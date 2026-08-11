-- Pay-as-you-go: the third way to pay for usage past a spent wallet.
--
-- The other two charge the card at the moment of purchase. This one accrues and
-- bills at the end of the cycle, so it is the only mode where a customer can owe
-- money nobody has charged yet. maxMonthlySpend is therefore enforced on every
-- accrual, not at settlement.

-- New answer to "what happens once credits run out".
ALTER TYPE "AutoPurchaseLimitBehavior" ADD VALUE IF NOT EXISTS 'PAYG';

-- Arrears must never read as a prepaid top-up on a document or in revenue.
ALTER TYPE "InvoiceType" ADD VALUE IF NOT EXISTS 'PAYG_SETTLEMENT';

-- The PAYG rate is deliberately NOT price_per_credit: that one prices an
-- auto-purchase top-up, and pricing both off one column would make a discount on
-- one silently discount the other.
ALTER TABLE "auto_purchase_policies"
  ADD COLUMN IF NOT EXISTS "payg_price_per_credit" DECIMAL(12,6);

DO $$ BEGIN
  CREATE TYPE "PaygAccrualStatus" AS ENUM ('OPEN', 'SETTLING', 'SETTLED', 'VOID');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "payg_accruals" (
  "id"                 TEXT NOT NULL,
  "billable_entity_id" TEXT NOT NULL,
  -- The subscription's spend window, not the calendar month.
  "period_key"         TEXT NOT NULL,
  "units"              DECIMAL(18,6) NOT NULL DEFAULT 0,
  "amount"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  "currency"           TEXT NOT NULL,
  "price_per_credit"   DECIMAL(12,6) NOT NULL,
  "status"             "PaygAccrualStatus" NOT NULL DEFAULT 'OPEN',
  "capped_at"          TIMESTAMP(3),
  "settled_charge_id"  TEXT,
  "settled_at"         TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payg_accruals_pkey" PRIMARY KEY ("id")
);

-- One row per entity per window. This unique is what makes concurrent accrual
-- an upsert race the database settles, rather than two half-rows to reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS "payg_accruals_billable_entity_id_period_key_key"
  ON "payg_accruals" ("billable_entity_id", "period_key");

CREATE INDEX IF NOT EXISTS "payg_accruals_status_idx" ON "payg_accruals" ("status");

DO $$ BEGIN
  ALTER TABLE "payg_accruals"
    ADD CONSTRAINT "payg_accruals_billable_entity_id_fkey"
    FOREIGN KEY ("billable_entity_id") REFERENCES "billable_entities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
