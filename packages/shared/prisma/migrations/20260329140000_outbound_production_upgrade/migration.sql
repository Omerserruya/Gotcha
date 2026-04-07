-- Outbound Production Upgrade Migration
-- Adds: opt-out, message tracking, flow support, template meta fields, smart segments

-- Contact: opt-out + smart segment fields
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "tags" JSONB DEFAULT '[]';
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "last_interaction_at" TIMESTAMP(3);
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "opt_out_channels" JSONB DEFAULT '[]';
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "opted_out_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "contacts_tenant_id_last_interaction_at_idx" ON "contacts"("tenant_id", "last_interaction_at");

-- MessageTemplate: Meta integration fields
ALTER TABLE "message_templates" ADD COLUMN IF NOT EXISTS "meta_template_id" TEXT;
ALTER TABLE "message_templates" ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;

-- Broadcast: flow support
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "flow_id" TEXT;

-- ScheduledMessage: send type + flow + department
ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "send_type" TEXT DEFAULT 'regular';
ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "department_id" TEXT;
ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "flow_id" TEXT;

-- Message: tracking links + delivery timestamps
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "broadcast_id" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "scheduled_message_id" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "error_message" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMP(3);
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "messages_broadcast_id_idx" ON "messages"("broadcast_id");
CREATE INDEX IF NOT EXISTS "messages_scheduled_message_id_idx" ON "messages"("scheduled_message_id");
