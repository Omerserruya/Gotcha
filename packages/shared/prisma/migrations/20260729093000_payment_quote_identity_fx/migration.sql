-- Allow a quote with no FX rate row.
--
-- An ILS-priced plan charged in ILS involves no conversion, so there is no
-- approved rate to pin. Requiring one would mean inventing a 1.0 USD->ILS row,
-- which is a lie in the audit trail. Identity quotes instead record source
-- 'IDENTITY' with rate 1 and no rate id, and a CHECK enforces that the two
-- cases cannot be confused.
ALTER TABLE "payment_quotes" DROP CONSTRAINT "payment_quotes_fx_rate_id_fkey";
ALTER TABLE "payment_quotes" ALTER COLUMN "fx_rate_id" DROP NOT NULL;
ALTER TABLE "payment_quotes"
  ADD CONSTRAINT "payment_quotes_fx_rate_id_fkey"
  FOREIGN KEY ("fx_rate_id") REFERENCES "billing_exchange_rates"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A converted quote MUST pin an approved rate; an identity quote MUST NOT.
-- Without this, a converted quote could lose its rate reference and still look
-- well-formed.
ALTER TABLE "payment_quotes"
  ADD CONSTRAINT "payment_quotes_identity_or_rate"
  CHECK (
    ("fx_rate_source" = 'IDENTITY' AND "fx_rate_id" IS NULL AND "fx_rate" = 1
       AND "commercial_currency" = "charge_currency")
    OR
    ("fx_rate_source" <> 'IDENTITY' AND "fx_rate_id" IS NOT NULL)
  );
