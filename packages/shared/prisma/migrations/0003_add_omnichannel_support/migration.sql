-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP', 'MESSENGER');

-- CreateEnum
CREATE TYPE "BotFlowMode" AS ENUM ('UNIFIED', 'PER_CHANNEL');

-- CreateTable
CREATE TABLE "channel_accounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_channel_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bot_flow_mode" "BotFlowMode" NOT NULL DEFAULT 'UNIFIED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_channel_configs_pkey" PRIMARY KEY ("id")
);

-- AlterTable: conversations - add channel fields
ALTER TABLE "conversations" ADD COLUMN "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP';
ALTER TABLE "conversations" ADD COLUMN "channel_account_id" TEXT;
ALTER TABLE "conversations" ADD COLUMN "customer_external_id" TEXT;

-- Backfill customer_external_id from customer_phone for existing rows
UPDATE "conversations" SET "customer_external_id" = "customer_phone" WHERE "customer_external_id" IS NULL;

-- Now make it NOT NULL
ALTER TABLE "conversations" ALTER COLUMN "customer_external_id" SET NOT NULL;

-- Make customer_phone nullable (Messenger/Instagram don't have phone numbers)
ALTER TABLE "conversations" ALTER COLUMN "customer_phone" DROP NOT NULL;

-- AlterTable: messages - add channel and external_message_id
ALTER TABLE "messages" ADD COLUMN "channel" "ChannelType";
ALTER TABLE "messages" ADD COLUMN "external_message_id" TEXT;

-- Backfill external_message_id from wa_message_id for existing rows
UPDATE "messages" SET "external_message_id" = "wa_message_id" WHERE "wa_message_id" IS NOT NULL;

-- AlterTable: chatbot_flows - add channel scope
ALTER TABLE "chatbot_flows" ADD COLUMN "channel" "ChannelType";

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_channel_external_id_key" ON "channel_accounts"("channel", "external_id");
CREATE INDEX "channel_accounts_tenant_id_idx" ON "channel_accounts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_channel_configs_tenant_id_key" ON "tenant_channel_configs"("tenant_id");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_channel_customer_external_id_idx" ON "conversations"("tenant_id", "channel", "customer_external_id");

-- CreateIndex
CREATE INDEX "messages_external_message_id_idx" ON "messages"("external_message_id");

-- CreateIndex
CREATE INDEX "chatbot_flows_tenant_id_channel_is_active_idx" ON "chatbot_flows"("tenant_id", "channel", "is_active");

-- AddForeignKey
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_channel_configs" ADD CONSTRAINT "tenant_channel_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_id_fkey" FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Migrate existing WhatsApp config from tenants to channel_accounts
INSERT INTO "channel_accounts" ("id", "tenant_id", "channel", "external_id", "display_name", "credentials", "is_active", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    "id",
    'WHATSAPP'::"ChannelType",
    "wa_phone_number_id",
    "name" || ' WhatsApp',
    jsonb_build_object('accessToken', "wa_access_token", 'webhookSecret', "wa_webhook_secret"),
    true,
    NOW(),
    NOW()
FROM "tenants"
WHERE "wa_phone_number_id" IS NOT NULL;

-- Link existing conversations to their channel accounts
UPDATE "conversations" c
SET "channel_account_id" = ca."id"
FROM "channel_accounts" ca
WHERE ca."tenant_id" = c."tenant_id" AND ca."channel" = 'WHATSAPP';

-- Create default TenantChannelConfig for existing tenants
INSERT INTO "tenant_channel_configs" ("id", "tenant_id", "bot_flow_mode", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    "id",
    'UNIFIED'::"BotFlowMode",
    NOW(),
    NOW()
FROM "tenants";
