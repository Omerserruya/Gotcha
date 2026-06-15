-- Webhook trigger - lets a workflow (ChatbotFlow) be fired by an inbound HTTP
-- call instead of the built-in trigger kinds (channel_entry / comment /
-- keyword / schedule). Foundation for the custom-webhook-as-workflow-trigger
-- feature; pure data model, no route/dispatch logic.
--
-- Purely additive (new table + indexes + FKs); no edits to existing objects.
-- Idempotent (IF NOT EXISTS / duplicate_object guards) so it is safe to re-run
-- on environments seeded out-of-band via `prisma db push`.

CREATE TABLE IF NOT EXISTS "webhook_triggers" (
  "id"          TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "token"       TEXT NOT NULL,
  "secret"      TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_triggers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_triggers_token_key" ON "webhook_triggers"("token");
CREATE INDEX IF NOT EXISTS "webhook_triggers_tenant_id_idx" ON "webhook_triggers"("tenant_id");
CREATE INDEX IF NOT EXISTS "webhook_triggers_workflow_id_idx" ON "webhook_triggers"("workflow_id");

DO $$ BEGIN
  ALTER TABLE "webhook_triggers"
    ADD CONSTRAINT "webhook_triggers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "webhook_triggers"
    ADD CONSTRAINT "webhook_triggers_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "chatbot_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
