-- Shopify billing foundation: billing source, commerce connections, policy
-- audit, usage ledger, outbox.
--
-- HAND-WRITTEN, deliberately. `prisma migrate diff --from-migrations` cannot be
-- used to generate this file: schema.prisma on main already differs from its own
-- migration history by ~214 lines, including DROP TABLE for copilot_configs,
-- department_copilot_configs and first_take_care_configs. A generated migration
-- would sweep that pre-existing drift in and drop three tables. Whether that
-- drift should be reconciled is a real question, but it is not this change's
-- question, and it must not ride along with it.
--
-- Everything here is ADDITIVE. No column is dropped, no constraint is altered,
-- no existing row is rewritten. Reversal is the DOWN block at the end of this
-- file, kept as a comment because Prisma does not run down migrations.

-- ─── Enums ────────────────────────────────────────────────────────────────
CREATE TYPE "BillingSource" AS ENUM ('GOTCHA_EXTERNAL', 'SHOPIFY', 'EXEMPT', 'FREE');
CREATE TYPE "BillingPolicy" AS ENUM ('FULL_SHOPIFY', 'SHOPIFY_CONNECTOR_ADDON', 'GRANDFATHERED_EXTERNAL', 'EXTERNAL_ONLY', 'FREE', 'UNRESOLVED');
CREATE TYPE "PolicyEvidenceQuality" AS ENUM ('CONFIRMED', 'INFERRED', 'UNKNOWN', 'REVIEW_REQUIRED');
CREATE TYPE "ProviderSubscriptionStatus" AS ENUM ('PENDING', 'TRIALING', 'ACTIVE', 'FROZEN', 'PAST_DUE', 'CANCELLED', 'DECLINED', 'EXPIRED', 'REQUIRES_ACTION');
CREATE TYPE "CommercePlatform" AS ENUM ('SHOPIFY', 'WOOCOMMERCE', 'OTHER');
CREATE TYPE "CommerceConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'BILLING_PENDING', 'DISCONNECTED');
CREATE TYPE "UsageDispatchStatus" AS ENUM ('RECORDED', 'PENDING', 'DISPATCHED', 'ACKED', 'FAILED', 'SKIPPED', 'REVERSED');

-- Postgres allows ADD VALUE inside a transaction (12+), but the new value may
-- not be USED in the same transaction. Nothing below writes it, so this is safe.
ALTER TYPE "EntitlementSource" ADD VALUE 'SHOPIFY_SUBSCRIPTION';

-- ─── Additive columns on existing tables ──────────────────────────────────
-- Every existing subscription is, by definition, billed by GOTCHA. The default
-- makes that true for existing rows without a data backfill step.
ALTER TABLE "subscriptions"
  ADD COLUMN "billing_source" "BillingSource" NOT NULL DEFAULT 'GOTCHA_EXTERNAL';

-- Nullable on purpose. NULL means "the pre-existing answer" - funded by GOTCHA's
-- own billing - so nothing has to be inferred about rows that predate Shopify.
ALTER TABLE "tenant_entitlements"
  ADD COLUMN "funded_by_billing_source" "BillingSource",
  ADD COLUMN "funded_by_provider_subscription_id" TEXT;

-- ─── commerce_connections ─────────────────────────────────────────────────
CREATE TABLE "commerce_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "platform" "CommercePlatform" NOT NULL,
    "external_shop_id" TEXT NOT NULL,
    "shop_domain" TEXT,
    "status" "CommerceConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "acquisition_source" TEXT,
    "shopify_chat_installation_id" TEXT,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "commerce_connections_pkey" PRIMARY KEY ("id")
);

-- The constraint that makes cross-tenant shop capture impossible at the
-- database, not merely in a code path someone might forget to call.
CREATE UNIQUE INDEX "commerce_connections_platform_external_shop_id_key" ON "commerce_connections"("platform", "external_shop_id");
CREATE INDEX "commerce_connections_tenant_id_idx" ON "commerce_connections"("tenant_id");
CREATE INDEX "commerce_connections_tenant_id_status_idx" ON "commerce_connections"("tenant_id", "status");
CREATE INDEX "commerce_connections_shop_domain_idx" ON "commerce_connections"("shop_domain");

-- ─── provider_subscriptions ───────────────────────────────────────────────
CREATE TABLE "provider_subscriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "billable_entity_id" TEXT NOT NULL,
    "billing_source" "BillingSource" NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'mock',
    "product_key" TEXT NOT NULL,
    "provider_subscription_id" TEXT,
    "provider_customer_id" TEXT,
    "provider_plan_handle" TEXT,
    "plan_key" TEXT,
    "plan_version" INTEGER,
    "status" "ProviderSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "provider_status_raw" TEXT,
    "trial_ends_at" TIMESTAMP(3),
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "commerce_connection_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_subscriptions_source_env_provider_id_key" ON "provider_subscriptions"("billing_source", "environment", "provider_subscription_id");
CREATE UNIQUE INDEX "provider_subscriptions_entity_source_product_key" ON "provider_subscriptions"("billable_entity_id", "billing_source", "product_key");
CREATE INDEX "provider_subscriptions_tenant_id_idx" ON "provider_subscriptions"("tenant_id");
CREATE INDEX "provider_subscriptions_status_idx" ON "provider_subscriptions"("status");
CREATE INDEX "provider_subscriptions_current_period_end_idx" ON "provider_subscriptions"("current_period_end");
CREATE INDEX "provider_subscriptions_commerce_connection_id_idx" ON "provider_subscriptions"("commerce_connection_id");

-- ─── billing_policy_decisions ─────────────────────────────────────────────
CREATE TABLE "billing_policy_decisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "policy" "BillingPolicy" NOT NULL,
    "reason" TEXT NOT NULL,
    "acquisition_source" TEXT,
    "account_created_at" TIMESTAMP(3),
    "cohort" TEXT,
    "grandfathered" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "evidence_quality" "PolicyEvidenceQuality" NOT NULL DEFAULT 'UNKNOWN',
    "commerce_connection_id" TEXT,
    "code_version" TEXT,
    "config_version" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" TEXT,
    CONSTRAINT "billing_policy_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_policy_decisions_tenant_id_decided_at_idx" ON "billing_policy_decisions"("tenant_id", "decided_at");
CREATE INDEX "billing_policy_decisions_policy_idx" ON "billing_policy_decisions"("policy");
CREATE INDEX "billing_policy_decisions_evidence_quality_idx" ON "billing_policy_decisions"("evidence_quality");

-- ─── usage_ledger_entries ─────────────────────────────────────────────────
CREATE TABLE "usage_ledger_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "billable_entity_id" TEXT,
    "provider_subscription_id" TEXT,
    "subscription_id" TEXT,
    "entitlement_key" TEXT,
    "metric" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "billing_source" "BillingSource" NOT NULL,
    "status" "UsageDispatchStatus" NOT NULL DEFAULT 'RECORDED',
    "provider_event_id" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "failure_reason" TEXT,
    "reversal_of_id" TEXT,
    "skip_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "usage_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- The single guard against billing one unit twice. Everything that dispatches
-- usage keys on this, and Shopify enforces its own copy of it permanently.
CREATE UNIQUE INDEX "usage_ledger_entries_idempotency_key_key" ON "usage_ledger_entries"("idempotency_key");
CREATE INDEX "usage_ledger_entries_tenant_id_metric_occurred_at_idx" ON "usage_ledger_entries"("tenant_id", "metric", "occurred_at");
CREATE INDEX "usage_ledger_entries_status_next_attempt_at_idx" ON "usage_ledger_entries"("status", "next_attempt_at");
CREATE INDEX "usage_ledger_entries_billing_source_status_idx" ON "usage_ledger_entries"("billing_source", "status");
CREATE INDEX "usage_ledger_entries_provider_subscription_id_idx" ON "usage_ledger_entries"("provider_subscription_id");
CREATE INDEX "usage_ledger_entries_reversal_of_id_idx" ON "usage_ledger_entries"("reversal_of_id");

-- ─── billing_outbox_entries ───────────────────────────────────────────────
CREATE TABLE "billing_outbox_entries" (
    "id" TEXT NOT NULL,
    "billing_source" "BillingSource" NOT NULL,
    "operation" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "tenant_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "UsageDispatchStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "dead_lettered_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_outbox_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_outbox_entries_dedupe_key_key" ON "billing_outbox_entries"("dedupe_key");
CREATE INDEX "billing_outbox_entries_status_next_attempt_at_idx" ON "billing_outbox_entries"("status", "next_attempt_at");
CREATE INDEX "billing_outbox_entries_tenant_id_idx" ON "billing_outbox_entries"("tenant_id");

-- ─── Reversal ─────────────────────────────────────────────────────────────
-- Prisma has no down migrations, so this is the script to run by hand. It is
-- complete: nothing above modifies existing data, so dropping these restores
-- the previous state exactly.
--
--   DROP TABLE IF EXISTS "billing_outbox_entries";
--   DROP TABLE IF EXISTS "usage_ledger_entries";
--   DROP TABLE IF EXISTS "billing_policy_decisions";
--   DROP TABLE IF EXISTS "provider_subscriptions";
--   DROP TABLE IF EXISTS "commerce_connections";
--   ALTER TABLE "tenant_entitlements"
--     DROP COLUMN IF EXISTS "funded_by_provider_subscription_id",
--     DROP COLUMN IF EXISTS "funded_by_billing_source";
--   ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "billing_source";
--   DROP TYPE IF EXISTS "UsageDispatchStatus";
--   DROP TYPE IF EXISTS "CommerceConnectionStatus";
--   DROP TYPE IF EXISTS "CommercePlatform";
--   DROP TYPE IF EXISTS "ProviderSubscriptionStatus";
--   DROP TYPE IF EXISTS "PolicyEvidenceQuality";
--   DROP TYPE IF EXISTS "BillingPolicy";
--   DROP TYPE IF EXISTS "BillingSource";
--
-- The one thing that does NOT reverse is `ALTER TYPE "EntitlementSource" ADD
-- VALUE 'SHOPIFY_SUBSCRIPTION'` - Postgres cannot drop an enum value. It is
-- inert when unused, so it is left in place rather than rebuilding the type.
