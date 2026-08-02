-- Provider customer mapping + provider-neutral inbound event storage.
-- Purely additive. Hand-written: generated diff also emits unrelated dev drift.

CREATE TYPE "ProviderCustomerStatus" AS ENUM ('ACTIVE', 'STALE', 'REVOKED');
CREATE TYPE "ProviderEventVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'INVALID', 'UNSUPPORTED');
CREATE TYPE "ProviderEventProcessing" AS ENUM (
  'RECEIVED', 'VERIFIED', 'REJECTED', 'PROCESSING', 'PROCESSED', 'DUPLICATE', 'FAILED', 'MANUAL_REVIEW'
);

CREATE TABLE "provider_customers" (
  "id"                   TEXT NOT NULL,
  "provider"             "BillingProvider" NOT NULL DEFAULT 'ICOUNT',
  "environment"          TEXT NOT NULL DEFAULT 'mock',
  "tenant_id"            TEXT NOT NULL,
  "billable_entity_id"   TEXT NOT NULL,
  "provider_customer_id" TEXT NOT NULL,
  "external_reference"   TEXT NOT NULL,
  "status"               "ProviderCustomerStatus" NOT NULL DEFAULT 'ACTIVE',
  "last_synced_at"       TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_customers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_customers_external_reference_key"
  ON "provider_customers"("external_reference");
-- One mapping per entity per provider per environment...
CREATE UNIQUE INDEX "provider_customers_provider_environment_billable_entity_id_key"
  ON "provider_customers"("provider", "environment", "billable_entity_id");
-- ...and a provider customer id may not be claimed by two entities.
CREATE UNIQUE INDEX "provider_customers_provider_environment_provider_customer_id_key"
  ON "provider_customers"("provider", "environment", "provider_customer_id");
CREATE INDEX "provider_customers_tenant_id_idx" ON "provider_customers"("tenant_id");

CREATE TABLE "provider_billing_events" (
  "id"                 TEXT NOT NULL,
  "provider"           "BillingProvider" NOT NULL DEFAULT 'ICOUNT',
  "environment"        TEXT NOT NULL DEFAULT 'mock',
  "external_event_id"  TEXT,
  "payload_hash"       TEXT NOT NULL,
  "redacted_payload"   JSONB NOT NULL,
  "received_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verification"       "ProviderEventVerification" NOT NULL DEFAULT 'UNVERIFIED',
  "processing"         "ProviderEventProcessing" NOT NULL DEFAULT 'RECEIVED',
  "checkout_id"        TEXT,
  "payment_attempt_id" TEXT,
  "duplicate_of_id"    TEXT,
  "failure_code"       TEXT,
  "failure_reason"     TEXT,
  "processed_at"       TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_billing_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_billing_events_provider_environment_external_event_id_key"
  ON "provider_billing_events"("provider", "environment", "external_event_id");
CREATE INDEX "provider_billing_events_provider_payload_hash_idx"
  ON "provider_billing_events"("provider", "payload_hash");
CREATE INDEX "provider_billing_events_processing_idx" ON "provider_billing_events"("processing");
CREATE INDEX "provider_billing_events_checkout_id_idx" ON "provider_billing_events"("checkout_id");
