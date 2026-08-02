-- Approved billing FX rate + immutable payment quote.
--
-- Separate from fx_rate_snapshots on purpose: that table refreshes itself from
-- an external source and falls back to a hardcoded rate on failure, which is
-- fine for showing an approximate price and unacceptable for deciding what to
-- charge. This one is human-approved, versioned and never fetches.
-- Purely additive.

CREATE TYPE "BillingExchangeRateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE "PaymentQuoteStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'SUPERSEDED');

CREATE TABLE "billing_exchange_rates" (
  "id"             TEXT NOT NULL,
  "base_currency"  TEXT NOT NULL DEFAULT 'USD',
  "quote_currency" TEXT NOT NULL DEFAULT 'ILS',
  "rate"           DECIMAL(18,8) NOT NULL,
  "source"         TEXT NOT NULL DEFAULT 'MANUAL_PLATFORM_RATE',
  "version"        INTEGER NOT NULL,
  "active_from"    TIMESTAMP(3) NOT NULL,
  "active_until"   TIMESTAMP(3),
  "status"         "BillingExchangeRateStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by"     TEXT,
  "approved_by"    TEXT,
  "approved_at"    TIMESTAMP(3),
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_exchange_rates_base_quote_version_key"
  ON "billing_exchange_rates"("base_currency", "quote_currency", "version");
CREATE INDEX "billing_exchange_rates_lookup_idx"
  ON "billing_exchange_rates"("base_currency", "quote_currency", "status", "active_from");

-- At most ONE approved rate per currency pair can be active. A partial unique
-- index makes a second one a database error rather than a coin flip at charge
-- time over which rate the customer gets.
CREATE UNIQUE INDEX "billing_exchange_rates_one_active_per_pair"
  ON "billing_exchange_rates"("base_currency", "quote_currency")
  WHERE "status" = 'ACTIVE';

CREATE TABLE "payment_quotes" (
  "id"                     TEXT NOT NULL,
  "tenant_id"              TEXT,
  "checkout_id"            TEXT,
  "subscription_id"        TEXT,
  "purpose"                TEXT NOT NULL,
  "commercial_amount"      DECIMAL(12,2) NOT NULL,
  "commercial_currency"    TEXT NOT NULL,
  "fx_rate_id"             TEXT NOT NULL,
  "fx_rate"                DECIMAL(18,8) NOT NULL,
  "fx_rate_source"         TEXT NOT NULL,
  "fx_rate_version"        INTEGER NOT NULL,
  "fx_quoted_at"           TIMESTAMP(3) NOT NULL,
  "charge_amount"          DECIMAL(12,2) NOT NULL,
  "charge_currency"        TEXT NOT NULL,
  "provider_currency_id"   INTEGER NOT NULL,
  "rounding_mode"          TEXT NOT NULL DEFAULT 'HALF_UP',
  "expires_at"             TIMESTAMP(3) NOT NULL,
  "status"                 "PaymentQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
  "consumed_by_attempt_id" TEXT,
  "consumed_at"            TIMESTAMP(3),
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_quotes_pkey" PRIMARY KEY ("id")
);

-- One quote, one charge.
CREATE UNIQUE INDEX "payment_quotes_consumed_by_attempt_id_key"
  ON "payment_quotes"("consumed_by_attempt_id");
CREATE INDEX "payment_quotes_checkout_id_idx"  ON "payment_quotes"("checkout_id");
CREATE INDEX "payment_quotes_tenant_id_idx"    ON "payment_quotes"("tenant_id");
CREATE INDEX "payment_quotes_status_expires_idx" ON "payment_quotes"("status", "expires_at");

ALTER TABLE "payment_quotes"
  ADD CONSTRAINT "payment_quotes_fx_rate_id_fkey"
  FOREIGN KEY ("fx_rate_id") REFERENCES "billing_exchange_rates"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The quote a payment attempt actually used.
ALTER TABLE "payment_attempts"
  ADD COLUMN IF NOT EXISTS "payment_quote_id"     TEXT,
  ADD COLUMN IF NOT EXISTS "charge_amount"        DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "charge_currency"      TEXT,
  ADD COLUMN IF NOT EXISTS "provider_currency_id" INTEGER;

CREATE INDEX IF NOT EXISTS "payment_attempts_payment_quote_id_idx"
  ON "payment_attempts"("payment_quote_id");
