-- Inverse of migration.sql. Fails if two numbers now hold a template of the
-- same name, language and channel: that is the state the old key forbade, so
-- one of them has to be renamed or removed first.
DROP INDEX "message_templates_tenant_name_lang_channel_account_key";
CREATE UNIQUE INDEX "message_templates_tenant_id_name_language_channel_key" ON "message_templates"("tenant_id", "name", "language", "channel");
