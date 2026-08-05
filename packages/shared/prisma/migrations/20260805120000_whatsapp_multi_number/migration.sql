-- WhatsApp multi-number architecture.
--
-- Adds a per-number lifecycle record hanging off channel_accounts, plus an
-- append-only audit of every onboarding/repair/health step taken against a
-- single number.
--
-- Purely additive. No existing column changes, no data movement. Existing
-- WhatsApp channel_accounts keep working untouched; they simply have no
-- whatsapp_numbers row until they are inspected or reconnected, which the
-- application treats as "legacy, not yet profiled" rather than as an error.

-- CreateEnum
CREATE TYPE "WhatsAppOnboardingFlow" AS ENUM (
  'NEW_NUMBER',
  'COEXISTENCE',
  'EXISTING_CLOUD_API',
  'RECONNECT',
  'MIGRATION'
);

-- CreateEnum
CREATE TYPE "WhatsAppNumberState" AS ENUM (
  'DISCOVERED',
  'ONBOARDING',
  'ACTION_REQUIRED',
  'CONNECTED',
  'DEGRADED',
  'DISCONNECTED',
  'FAILED'
);

-- CreateEnum
CREATE TYPE "WhatsAppPendingAction" AS ENUM (
  'TWO_STEP_PIN',
  'VERIFICATION_CODE',
  'BUSINESS_APP_CONFIRMATION',
  'BUSINESS_VERIFICATION',
  'DISPLAY_NAME_REVIEW'
);

-- CreateTable
CREATE TABLE "whatsapp_numbers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel_account_id" TEXT NOT NULL,
    "business_portfolio_id" TEXT,
    "waba_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone_number" TEXT,
    "verified_name" TEXT,
    "platform_type" TEXT,
    "is_on_biz_app" BOOLEAN NOT NULL DEFAULT false,
    "onboarding_flow" "WhatsAppOnboardingFlow" NOT NULL,
    "state" "WhatsAppNumberState" NOT NULL DEFAULT 'ONBOARDING',
    "pending_action" "WhatsAppPendingAction",
    "messaging_status" TEXT,
    "code_verification_status" TEXT,
    "name_status" TEXT,
    "quality_rating" TEXT,
    "throughput_level" TEXT,
    "messaging_limit_tier" TEXT,
    "webhook_subscribed" BOOLEAN NOT NULL DEFAULT false,
    "webhook_verified_at" TIMESTAMP(3),
    "webhook_override_uri" TEXT,
    "health_snapshot" JSONB,
    "can_send_message" TEXT,
    "last_health_check" TIMESTAMP(3),
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3),
    "connected_by" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_number_events" (
    "id" TEXT NOT NULL,
    "number_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "meta_error_code" INTEGER,
    "message" TEXT,
    "detail" JSONB,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_number_events_pkey" PRIMARY KEY ("id")
);

-- One lifecycle row per channel, and one per Meta phone number id. The second
-- constraint is what stops the same number being connected twice, including
-- from two different tenants.
-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_channel_account_id_key" ON "whatsapp_numbers"("channel_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_numbers_phone_number_id_key" ON "whatsapp_numbers"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_tenant_id_idx" ON "whatsapp_numbers"("tenant_id");

-- "Which of this tenant's numbers need attention" is the management screen's
-- primary query and must not table-scan as tenants add numbers.
-- CreateIndex
CREATE INDEX "whatsapp_numbers_tenant_id_state_idx" ON "whatsapp_numbers"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_waba_id_idx" ON "whatsapp_numbers"("waba_id");

-- CreateIndex
CREATE INDEX "whatsapp_numbers_business_portfolio_id_idx" ON "whatsapp_numbers"("business_portfolio_id");

-- CreateIndex
CREATE INDEX "whatsapp_number_events_number_id_created_at_idx" ON "whatsapp_number_events"("number_id", "created_at");

-- Idempotency lookups ask "did this step already succeed for this number".
-- CreateIndex
CREATE INDEX "whatsapp_number_events_number_id_step_idx" ON "whatsapp_number_events"("number_id", "step");

-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade: the lifecycle record has no meaning without the channel it profiles.
-- AddForeignKey
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_number_events" ADD CONSTRAINT "whatsapp_number_events_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "whatsapp_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
