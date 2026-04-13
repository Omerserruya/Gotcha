-- Add channel_account_id to message_templates so templates can be bound to a specific connected account (e.g. a specific WABA)
ALTER TABLE "message_templates"
  ADD COLUMN "channel_account_id" TEXT;

ALTER TABLE "message_templates"
  ADD CONSTRAINT "message_templates_channel_account_id_fkey"
  FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "message_templates_tenant_id_channel_account_id_idx"
  ON "message_templates"("tenant_id", "channel_account_id");
