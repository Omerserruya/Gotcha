-- Platform WhatsApp alerts number (2026-11-15). Two new tables and two enums,
-- no data: rows are seeded by the console on first read. Additive only.

CREATE TYPE "PlatformSenderStatus" AS ENUM ('CONNECTED', 'PENDING_WEBHOOK', 'TOKEN_INVALID', 'DISCONNECTED');

CREATE TYPE "PlatformTemplateStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION');

CREATE TABLE "platform_whatsapp_senders" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "status" "PlatformSenderStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "business_portfolio_id" TEXT,
    "waba_id" TEXT,
    "phone_number_id" TEXT,
    "display_phone_number" TEXT,
    "verified_name" TEXT,
    "quality_rating" TEXT,
    "messaging_limit_tier" TEXT,
    "credentials" TEXT,
    "alerts_enabled" JSONB NOT NULL DEFAULT '{}',
    "last_error" TEXT,
    "connected_at" TIMESTAMP(3),
    "connected_by" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_whatsapp_senders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_whatsapp_templates" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "PlatformTemplateStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "rejected_reason" TEXT,
    "meta_template_id" TEXT,
    "draft_body" TEXT,
    "submitted_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_whatsapp_senders_phone_number_id_key" ON "platform_whatsapp_senders"("phone_number_id");

CREATE UNIQUE INDEX "platform_whatsapp_templates_event_type_language_key" ON "platform_whatsapp_templates"("event_type", "language");

CREATE INDEX "platform_whatsapp_templates_name_language_idx" ON "platform_whatsapp_templates"("name", "language");
