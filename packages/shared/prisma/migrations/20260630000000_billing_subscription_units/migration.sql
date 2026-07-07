-- CreateEnum
CREATE TYPE "BillableEntityKind" AS ENUM ('TENANT', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED', 'PAUSED', 'GRANDFATHERED');

-- CreateEnum
CREATE TYPE "BillingProfileStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PaymentMethodStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REMOVED');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('ICOUNT', 'STRIPE', 'MANUAL');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('SUBSCRIPTION', 'CREDIT_PURCHASE', 'AUTO_PURCHASE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'FAILED', 'VOID');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "PendingChangeType" AS ENUM ('DOWNGRADE', 'CANCEL');

-- CreateEnum
CREATE TYPE "AiUnitBucket" AS ENUM ('INCLUDED', 'PURCHASED');

-- CreateEnum
CREATE TYPE "AiUnitGrantType" AS ENUM ('PLAN', 'PURCHASE', 'AUTO', 'PROMO', 'TRIAL');

-- CreateEnum
CREATE TYPE "AiUnitEntryType" AS ENUM ('GRANT', 'CONSUME', 'EXPIRE', 'ADJUST', 'REFUND');

-- CreateEnum
CREATE TYPE "EntitlementValueType" AS ENUM ('BOOLEAN', 'COUNTER', 'CONFIG');

-- CreateEnum
CREATE TYPE "EntitlementSource" AS ENUM ('PLAN_DEFAULT', 'OVERRIDE', 'PROMO', 'TRIAL', 'ADDON', 'BETA');

-- AlterTable
ALTER TABLE "usage_logs" ADD COLUMN     "billed_period_key" TEXT,
ADD COLUMN     "ledger_entry_id" TEXT,
ADD COLUMN     "units_consumed" DECIMAL(16,6);

-- CreateTable
CREATE TABLE "billable_entities" (
    "id" TEXT NOT NULL,
    "kind" "BillableEntityKind" NOT NULL DEFAULT 'TENANT',
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billable_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billable_entity_tenants" (
    "id" TEXT NOT NULL,
    "billable_entity_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billable_entity_tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "billing_interval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "base_price" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "included_ai_units" INTEGER NOT NULL DEFAULT 0,
    "sales_only" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_entitlements" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "entitlement_key" TEXT NOT NULL,
    "value_type" "EntitlementValueType" NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_packages" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "provider_price_ref" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billable_models" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "kind" TEXT NOT NULL DEFAULT 'CHAT',
    "input_cost_per_1m" DECIMAL(12,6) NOT NULL,
    "output_cost_per_1m" DECIMAL(12,6) NOT NULL,
    "cached_input_cost_per_1m" DECIMAL(12,6),
    "category_multiplier" DECIMAL(8,4) NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billable_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_pricing_configs" (
    "id" TEXT NOT NULL,
    "unit_cost_basis_usd" DECIMAL(12,8) NOT NULL,
    "margin_factor" DECIMAL(8,4) NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_pricing_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_entitlements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entitlement_key" TEXT NOT NULL,
    "value_type" "EntitlementValueType" NOT NULL,
    "value" JSONB NOT NULL,
    "source" "EntitlementSource" NOT NULL,
    "expires_at" TIMESTAMP(3),
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_unit_lots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bucket" "AiUnitBucket" NOT NULL,
    "grant_type" "AiUnitGrantType" NOT NULL,
    "units_granted" DECIMAL(16,6) NOT NULL,
    "units_remaining" DECIMAL(16,6) NOT NULL,
    "period_key" TEXT,
    "expires_at" TIMESTAMP(3),
    "source" TEXT,
    "reference_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_unit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_unit_ledger_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "lot_id" TEXT,
    "entry_type" "AiUnitEntryType" NOT NULL,
    "bucket" "AiUnitBucket" NOT NULL,
    "units" DECIMAL(16,6) NOT NULL,
    "period_key" TEXT,
    "source" TEXT,
    "reference_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_unit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_ai_balances" (
    "tenant_id" TEXT NOT NULL,
    "included_remaining" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "purchased_remaining" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "included_allowance" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "period_key" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_ai_balances_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "billing_profiles" (
    "id" TEXT NOT NULL,
    "billable_entity_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'ICOUNT',
    "provider_customer_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "billing_email" TEXT,
    "vat_id" TEXT,
    "status" "BillingProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "billing_profile_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'ICOUNT',
    "token" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "exp_month" INTEGER,
    "exp_year" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "PaymentMethodStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "billable_entity_id" TEXT NOT NULL,
    "billing_profile_id" TEXT,
    "plan_key" TEXT NOT NULL,
    "plan_version" INTEGER NOT NULL DEFAULT 1,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "enforcement_enabled" BOOLEAN NOT NULL DEFAULT true,
    "trial_ends_at" TIMESTAMP(3),
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "provider_subscription_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_subscription_changes" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "change_type" "PendingChangeType" NOT NULL,
    "target_plan_key" TEXT,
    "target_plan_version" INTEGER,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "pending_subscription_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "SubscriptionStatus",
    "to_status" "SubscriptionStatus",
    "actor" TEXT,
    "metadata" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "billable_entity_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'ICOUNT',
    "provider_invoice_ref" TEXT,
    "provider_pdf_url" TEXT,
    "type" "InvoiceType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "vat" DECIMAL(12,2),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "line_items" JSONB,
    "issued_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charges" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'ICOUNT',
    "provider_charge_ref" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "status" "ChargeStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "failure_code" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_purchase_policies" (
    "id" TEXT NOT NULL,
    "billable_entity_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "threshold_pct" INTEGER NOT NULL DEFAULT 10,
    "package_key" TEXT,
    "max_monthly_spend" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "month_spend_key" TEXT,
    "month_spent_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "last_triggered_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_purchase_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dunning_states" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_failure_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dunning_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billable_entity_tenants_tenant_id_key" ON "billable_entity_tenants"("tenant_id");

-- CreateIndex
CREATE INDEX "billable_entity_tenants_billable_entity_id_idx" ON "billable_entity_tenants"("billable_entity_id");

-- CreateIndex
CREATE INDEX "plans_key_idx" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_version_key" ON "plans"("key", "version");

-- CreateIndex
CREATE INDEX "plan_entitlements_plan_id_idx" ON "plan_entitlements"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_entitlements_plan_id_entitlement_key_key" ON "plan_entitlements"("plan_id", "entitlement_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_packages_key_key" ON "credit_packages"("key");

-- CreateIndex
CREATE INDEX "billable_models_model_active_effective_from_idx" ON "billable_models"("model", "active", "effective_from");

-- CreateIndex
CREATE INDEX "unit_pricing_configs_active_effective_from_idx" ON "unit_pricing_configs"("active", "effective_from");

-- CreateIndex
CREATE INDEX "tenant_entitlements_tenant_id_idx" ON "tenant_entitlements"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_entitlements_tenant_id_entitlement_key_idx" ON "tenant_entitlements"("tenant_id", "entitlement_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_entitlements_tenant_id_entitlement_key_source_key" ON "tenant_entitlements"("tenant_id", "entitlement_key", "source");

-- CreateIndex
CREATE INDEX "ai_unit_lots_tenant_id_bucket_created_at_idx" ON "ai_unit_lots"("tenant_id", "bucket", "created_at");

-- CreateIndex
CREATE INDEX "ai_unit_lots_tenant_id_period_key_idx" ON "ai_unit_lots"("tenant_id", "period_key");

-- CreateIndex
CREATE INDEX "ai_unit_ledger_entries_tenant_id_created_at_idx" ON "ai_unit_ledger_entries"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_unit_ledger_entries_tenant_id_entry_type_idx" ON "ai_unit_ledger_entries"("tenant_id", "entry_type");

-- CreateIndex
CREATE INDEX "ai_unit_ledger_entries_tenant_id_period_key_idx" ON "ai_unit_ledger_entries"("tenant_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_profiles_billable_entity_id_key" ON "billing_profiles"("billable_entity_id");

-- CreateIndex
CREATE INDEX "payment_methods_billing_profile_id_idx" ON "payment_methods"("billing_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_billable_entity_id_key" ON "subscriptions"("billable_entity_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_current_period_end_idx" ON "subscriptions"("current_period_end");

-- CreateIndex
CREATE INDEX "subscriptions_trial_ends_at_idx" ON "subscriptions"("trial_ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "pending_subscription_changes_subscription_id_key" ON "pending_subscription_changes"("subscription_id");

-- CreateIndex
CREATE INDEX "pending_subscription_changes_effective_at_applied_at_idx" ON "pending_subscription_changes"("effective_at", "applied_at");

-- CreateIndex
CREATE INDEX "subscription_events_subscription_id_at_idx" ON "subscription_events"("subscription_id", "at");

-- CreateIndex
CREATE INDEX "invoices_billable_entity_id_created_at_idx" ON "invoices"("billable_entity_id", "created_at");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "charges_idempotency_key_key" ON "charges"("idempotency_key");

-- CreateIndex
CREATE INDEX "charges_invoice_id_idx" ON "charges"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "auto_purchase_policies_billable_entity_id_key" ON "auto_purchase_policies"("billable_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "dunning_states_subscription_id_key" ON "dunning_states"("subscription_id");

-- CreateIndex
CREATE INDEX "dunning_states_next_retry_at_idx" ON "dunning_states"("next_retry_at");

-- CreateIndex
CREATE INDEX "usage_logs_tenant_id_billed_period_key_idx" ON "usage_logs"("tenant_id", "billed_period_key");

-- AddForeignKey
ALTER TABLE "billable_entity_tenants" ADD CONSTRAINT "billable_entity_tenants_billable_entity_id_fkey" FOREIGN KEY ("billable_entity_id") REFERENCES "billable_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_entity_tenants" ADD CONSTRAINT "billable_entity_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_unit_lots" ADD CONSTRAINT "ai_unit_lots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_unit_ledger_entries" ADD CONSTRAINT "ai_unit_ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_unit_ledger_entries" ADD CONSTRAINT "ai_unit_ledger_entries_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "ai_unit_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_ai_balances" ADD CONSTRAINT "tenant_ai_balances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_billable_entity_id_fkey" FOREIGN KEY ("billable_entity_id") REFERENCES "billable_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_billing_profile_id_fkey" FOREIGN KEY ("billing_profile_id") REFERENCES "billing_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billable_entity_id_fkey" FOREIGN KEY ("billable_entity_id") REFERENCES "billable_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_subscription_changes" ADD CONSTRAINT "pending_subscription_changes_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billable_entity_id_fkey" FOREIGN KEY ("billable_entity_id") REFERENCES "billable_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_purchase_policies" ADD CONSTRAINT "auto_purchase_policies_billable_entity_id_fkey" FOREIGN KEY ("billable_entity_id") REFERENCES "billable_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dunning_states" ADD CONSTRAINT "dunning_states_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

