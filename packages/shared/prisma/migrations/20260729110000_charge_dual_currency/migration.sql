-- The ILS figures behind a charge, alongside the commercial amount.
--
-- `amount` stays the agreed commercial figure (USD for the public catalog);
-- these record what was actually submitted to the provider. Keeping only one of
-- the two makes "how much did we charge them" unanswerable in whichever
-- currency you did not keep.
ALTER TABLE "charges"
  ADD COLUMN IF NOT EXISTS "payment_quote_id"     TEXT,
  ADD COLUMN IF NOT EXISTS "charge_amount"        DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "charge_currency"      TEXT,
  ADD COLUMN IF NOT EXISTS "provider_currency_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "fx_rate"              DECIMAL(18,8),
  ADD COLUMN IF NOT EXISTS "fx_rate_version"      INTEGER;

CREATE INDEX IF NOT EXISTS "charges_payment_quote_id_idx" ON "charges"("payment_quote_id");

-- UNKNOWN is a real outcome: the request was submitted and the answer never
-- arrived. Recording it as FAILED would invite a retry, and a retry here is a
-- second charge.
ALTER TYPE "ChargeStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';
