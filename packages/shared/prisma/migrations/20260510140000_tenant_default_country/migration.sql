-- Default country code per tenant — used to E.164-normalize bare phone
-- numbers (e.g. "0501234567") before they're stored as broadcast
-- recipient externalIds or sent through the outbound pipeline.
ALTER TABLE "tenants" ADD COLUMN "default_country_code" TEXT NOT NULL DEFAULT 'IL';
