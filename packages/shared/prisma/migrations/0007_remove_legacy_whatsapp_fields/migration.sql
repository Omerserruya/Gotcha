-- Remove legacy WhatsApp fields that have been replaced by ChannelAccount-based approach

-- Drop index on customerPhone before dropping column
DROP INDEX IF EXISTS "conversations_tenant_id_customer_phone_idx";

-- Drop index on waMessageId before dropping column
DROP INDEX IF EXISTS "messages_wa_message_id_idx";

-- Remove legacy columns from tenants
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "wa_phone_number_id";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "wa_access_token";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "wa_webhook_secret";

-- Remove legacy column from conversations
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "customer_phone";

-- Remove legacy column from messages
ALTER TABLE "messages" DROP COLUMN IF EXISTS "wa_message_id";
