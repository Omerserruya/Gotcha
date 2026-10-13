-- B9 (Omer, 2026-10-13): a template is unique per WhatsApp number, so two
-- numbers can each have their own template of the same name and language.
-- Hand-written; identical to Prisma's schema-to-schema diff. Inverse: down.sql.

-- DropIndex
DROP INDEX "message_templates_tenant_id_name_language_channel_key";

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenant_name_lang_channel_account_key" ON "message_templates"("tenant_id", "name", "language", "channel", "channel_account_id");
