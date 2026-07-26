-- Pricing, plans, entitlements and Sysadmin conversation-cost analytics.
--
-- Purely ADDITIVE. No table is dropped, no column is dropped, no existing value
-- is rewritten. Every new column is nullable or carries a default that preserves
-- current behaviour, so existing plans, subscriptions, invoices, credit packages
-- and the credit ledger are untouched by this migration.

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PlanKind" AS ENUM ('PUBLIC', 'CUSTOM', 'POC', 'TRIAL', 'LEGACY');

-- CreateEnum
CREATE TYPE "CreditExpiryPolicy" AS ENUM ('NEVER', 'DAYS_AFTER_PURCHASE', 'PERIOD_END');

-- CreateEnum
CREATE TYPE "AutoPurchaseLimitBehavior" AS ENUM ('STOP_AI', 'HUMAN_ONLY', 'REQUIRE_APPROVAL', 'PREPAID_ONLY');

-- CreateEnum
CREATE TYPE "FeatureCategory" AS ENUM ('COMMUNICATION', 'AI', 'VOICE', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "VolumeChannel" AS ENUM ('CHAT', 'VOICE');

-- CreateEnum
CREATE TYPE "EstimationScope" AS ENUM ('GLOBAL', 'PLAN', 'VOLUME_OPTION');

-- CreateEnum
CREATE TYPE "ConversationUsageStatus" AS ENUM ('OPEN', 'SETTLING', 'FINALIZED', 'REOPENED', 'EXCLUDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EntitlementSource" ADD VALUE 'VOLUME_OPTION';
ALTER TYPE "EntitlementSource" ADD VALUE 'COMPLIANCE_DENY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EntitlementValueType" ADD VALUE 'DECIMAL';
ALTER TYPE "EntitlementValueType" ADD VALUE 'ENUM';
ALTER TYPE "EntitlementValueType" ADD VALUE 'LIST';
ALTER TYPE "EntitlementValueType" ADD VALUE 'UNLIMITED';
ALTER TYPE "EntitlementValueType" ADD VALUE 'METERED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PendingChangeType" ADD VALUE 'UPGRADE';
ALTER TYPE "PendingChangeType" ADD VALUE 'VOLUME_CHANGE';


-- AlterTable: auto-purchase hardening (warning threshold, increment, lock)
ALTER TABLE "auto_purchase_policies" ADD COLUMN     "increment_credits" INTEGER,
ADD COLUMN     "limit_behavior" "AutoPurchaseLimitBehavior" NOT NULL DEFAULT 'STOP_AI',
ADD COLUMN     "lock_token" TEXT,
ADD COLUMN     "locked_at" TIMESTAMP(3),
ADD COLUMN     "price_per_credit" DECIMAL(12,6),
ADD COLUMN     "warning_threshold_pct" INTEGER NOT NULL DEFAULT 80;

-- AlterTable: credit package catalog configuration
ALTER TABLE "credit_packages" ADD COLUMN     "active_from" TIMESTAMP(3),
ADD COLUMN     "active_to" TIMESTAMP(3),
ADD COLUMN     "customer_visible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "discount_label" TEXT,
ADD COLUMN     "eligible_plan_keys" JSONB,
ADD COLUMN     "expiry_days" INTEGER,
ADD COLUMN     "expiry_policy" "CreditExpiryPolicy" NOT NULL DEFAULT 'NEVER',
ADD COLUMN     "internal_note" TEXT,
ADD COLUMN     "max_purchase_quantity" INTEGER,
ADD COLUMN     "name_he" TEXT,
ADD COLUMN     "scheduled_price" DECIMAL(12,2),
ADD COLUMN     "scheduled_price_from" TIMESTAMP(3),
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;


-- AlterTable: scheduled volume-selector change
ALTER TABLE "pending_subscription_changes" ADD COLUMN     "target_chat_volume_key" TEXT,
ADD COLUMN     "target_voice_volume_key" TEXT;

-- AlterTable: Plan becomes the canonical PlanVersion
ALTER TABLE "plans" ADD COLUMN     "approval_state" TEXT,
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "auto_purchase_eligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "chat_volume_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contract_end" TIMESTAMP(3),
ADD COLUMN     "contract_start" TIMESTAMP(3),
ADD COLUMN     "credit_packages_eligible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "data_retention_days" INTEGER,
ADD COLUMN     "description_en" TEXT,
ADD COLUMN     "description_he" TEXT,
ADD COLUMN     "effective_from" TIMESTAMP(3),
ADD COLUMN     "effective_to" TIMESTAMP(3),
ADD COLUMN     "internal_note" TEXT,
ADD COLUMN     "kind" "PlanKind" NOT NULL DEFAULT 'PUBLIC',
ADD COLUMN     "name_he" TEXT,
ADD COLUMN     "published_at" TIMESTAMP(3),
ADD COLUMN     "published_by" TEXT,
ADD COLUMN     "recommended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "support_level" TEXT,
ADD COLUMN     "tenant_id" TEXT,
ADD COLUMN     "voice_volume_enabled" BOOLEAN NOT NULL DEFAULT false;


-- AlterTable: subscription commercial snapshot
ALTER TABLE "subscriptions" ADD COLUMN     "billing_interval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "chat_volume_option_key" TEXT,
ADD COLUMN     "snapshot_at" TIMESTAMP(3),
ADD COLUMN     "snapshot_currency" TEXT,
ADD COLUMN     "snapshot_estimation" JSONB,
ADD COLUMN     "snapshot_included_credits" INTEGER,
ADD COLUMN     "snapshot_price" DECIMAL(12,2),
ADD COLUMN     "trial_poc_template_key" TEXT,
ADD COLUMN     "voice_volume_option_key" TEXT;

-- CreateTable
CREATE TABLE "feature_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_he" TEXT NOT NULL,
    "description_en" TEXT,
    "description_he" TEXT,
    "category" "FeatureCategory" NOT NULL,
    "entitlement_type" "EntitlementValueType" NOT NULL DEFAULT 'BOOLEAN',
    "default_value" JSONB,
    "enforcement_locations" JSONB,
    "customer_visible" BOOLEAN NOT NULL DEFAULT true,
    "sysadmin_only" BOOLEAN NOT NULL DEFAULT false,
    "implemented" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_volume_options" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "VolumeChannel" NOT NULL,
    "daily_volume" INTEGER NOT NULL,
    "business_days_per_month" INTEGER NOT NULL DEFAULT 25,
    "monthly_volume" INTEGER NOT NULL,
    "credits_per_unit" DECIMAL(12,4) NOT NULL,
    "additional_credits" INTEGER NOT NULL DEFAULT 0,
    "additional_price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "active_from" TIMESTAMP(3),
    "active_to" TIMESTAMP(3),
    "internal_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_volume_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_estimation_configs" (
    "id" TEXT NOT NULL,
    "scope" "EstimationScope" NOT NULL DEFAULT 'GLOBAL',
    "plan_id" TEXT,
    "volume_option_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "chat_credits_per_estimated_conversation" DECIMAL(12,4) NOT NULL,
    "voice_credits_per_estimated_call" DECIMAL(12,4) NOT NULL,
    "business_days_per_month" INTEGER NOT NULL DEFAULT 25,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "internal_note" TEXT,
    "created_by" TEXT,
    "published_at" TIMESTAMP(3),
    "published_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_estimation_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_currency_configs" (
    "id" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL DEFAULT 'USD',
    "display_currencies" JSONB NOT NULL,
    "ils_rounding_increment" INTEGER NOT NULL DEFAULT 5,
    "rounding_mode" TEXT NOT NULL DEFAULT 'UP',
    "fx_source" TEXT NOT NULL DEFAULT 'boi',
    "fx_refresh_hours" INTEGER NOT NULL DEFAULT 24,
    "fallback_usd_ils" DECIMAL(18,6) NOT NULL DEFAULT 3.700000,
    "charge_in_display_currency" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_currency_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate_snapshots" (
    "id" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL DEFAULT 'USD',
    "quote_currency" TEXT NOT NULL DEFAULT 'ILS',
    "rate" DECIMAL(18,8) NOT NULL,
    "source" TEXT NOT NULL,
    "rate_date" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_poc_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_he" TEXT NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "credit_cap" INTEGER NOT NULL,
    "all_features" BOOLEAN NOT NULL DEFAULT true,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "auto_purchase_enabled" BOOLEAN NOT NULL DEFAULT false,
    "customer_self_activate" BOOLEAN NOT NULL DEFAULT false,
    "restrictions" JSONB,
    "transfer_remaining_credits" BOOLEAN NOT NULL DEFAULT false,
    "banner_kind" TEXT NOT NULL DEFAULT 'TRIAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_poc_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_usage_aggregates" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversation_type" TEXT NOT NULL,
    "plan_key" TEXT,
    "ai_agent_id" TEXT,
    "primary_model" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "total_credits" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "total_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "model_cost_usd" DECIMAL(16,8) NOT NULL DEFAULT 0,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "summary_included" BOOLEAN NOT NULL DEFAULT false,
    "voice_included" BOOLEAN NOT NULL DEFAULT false,
    "status" "ConversationUsageStatus" NOT NULL DEFAULT 'OPEN',
    "calculation_version" INTEGER NOT NULL DEFAULT 1,
    "excluded_reason" TEXT,
    "merged_into_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_usage_aggregates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_usage_event_links" (
    "id" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "usage_log_id" TEXT NOT NULL,
    "credits" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(16,8) NOT NULL DEFAULT 0,
    "feature" TEXT,
    "model" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_usage_event_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_definitions_key_key" ON "feature_definitions"("key");

-- CreateIndex
CREATE INDEX "feature_definitions_category_sort_order_idx" ON "feature_definitions"("category", "sort_order");

-- CreateIndex
CREATE INDEX "plan_volume_options_plan_id_channel_sort_order_idx" ON "plan_volume_options"("plan_id", "channel", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "plan_volume_options_plan_id_key_key" ON "plan_volume_options"("plan_id", "key");

-- CreateIndex
CREATE INDEX "public_estimation_configs_scope_active_effective_from_idx" ON "public_estimation_configs"("scope", "active", "effective_from");

-- CreateIndex
CREATE INDEX "public_estimation_configs_plan_id_active_idx" ON "public_estimation_configs"("plan_id", "active");

-- CreateIndex
CREATE INDEX "public_estimation_configs_volume_option_id_active_idx" ON "public_estimation_configs"("volume_option_id", "active");

-- CreateIndex
CREATE INDEX "fx_rate_snapshots_base_currency_quote_currency_fetched_at_idx" ON "fx_rate_snapshots"("base_currency", "quote_currency", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_snapshots_base_currency_quote_currency_rate_date_so_key" ON "fx_rate_snapshots"("base_currency", "quote_currency", "rate_date", "source");

-- CreateIndex
CREATE UNIQUE INDEX "trial_poc_templates_key_key" ON "trial_poc_templates"("key");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_usage_aggregates_conversation_id_key" ON "conversation_usage_aggregates"("conversation_id");

-- CreateIndex
CREATE INDEX "conversation_usage_aggregates_tenant_id_status_idx" ON "conversation_usage_aggregates"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "conversation_usage_aggregates_tenant_id_conversation_type_f_idx" ON "conversation_usage_aggregates"("tenant_id", "conversation_type", "finalized_at");

-- CreateIndex
CREATE INDEX "conversation_usage_aggregates_status_resolved_at_idx" ON "conversation_usage_aggregates"("status", "resolved_at");

-- CreateIndex
CREATE INDEX "conversation_usage_aggregates_finalized_at_idx" ON "conversation_usage_aggregates"("finalized_at");

-- CreateIndex
CREATE INDEX "conversation_usage_aggregates_tenant_id_plan_key_finalized__idx" ON "conversation_usage_aggregates"("tenant_id", "plan_key", "finalized_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_usage_event_links_usage_log_id_key" ON "conversation_usage_event_links"("usage_log_id");

-- CreateIndex
CREATE INDEX "conversation_usage_event_links_aggregate_id_idx" ON "conversation_usage_event_links"("aggregate_id");

-- CreateIndex
CREATE INDEX "credit_packages_status_sort_order_idx" ON "credit_packages"("status", "sort_order");

-- CreateIndex
CREATE INDEX "plans_status_kind_idx" ON "plans"("status", "kind");

-- CreateIndex
CREATE INDEX "plans_tenant_id_idx" ON "plans"("tenant_id");


-- AddForeignKey
ALTER TABLE "plan_volume_options" ADD CONSTRAINT "plan_volume_options_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_estimation_configs" ADD CONSTRAINT "public_estimation_configs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_estimation_configs" ADD CONSTRAINT "public_estimation_configs_volume_option_id_fkey" FOREIGN KEY ("volume_option_id") REFERENCES "plan_volume_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_usage_event_links" ADD CONSTRAINT "conversation_usage_event_links_aggregate_id_fkey" FOREIGN KEY ("aggregate_id") REFERENCES "conversation_usage_aggregates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
