-- Billing identity + tax rates.
--
-- Additive only: three nullable columns on an existing table, and one new
-- table. Nothing is dropped and no existing value changes, so this is safe to
-- apply ahead of the code that reads it.
--
-- Israel is seeded at 18%. Every other country is absent on purpose - a
-- missing row means 0%, so "Israel charges VAT, nowhere else does" needs one
-- row rather than two hundred.

ALTER TABLE "billing_profiles" ADD COLUMN "billing_name" TEXT;
ALTER TABLE "billing_profiles" ADD COLUMN "billing_country" TEXT;
ALTER TABLE "billing_profiles" ADD COLUMN "billing_address" TEXT;

CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "internal_note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_rates_country_code_key" ON "tax_rates"("country_code");

CREATE INDEX "tax_rates_active_country_code_idx" ON "tax_rates"("active", "country_code");

INSERT INTO "tax_rates" ("id", "country_code", "percent", "label", "active", "internal_note", "updated_at")
VALUES ('taxrate_il_seed', 'IL', 18.00, 'מע"מ', true, 'Seeded with the migration. Change the rate here, not in code.', CURRENT_TIMESTAMP);
