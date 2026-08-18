-- Disconnecting a channel must not erase what happened on it.
--
-- `conversations.channel_account_id` and `historical_imports.channel_account_id`
-- both cascaded, so deleting a WhatsApp number's channel account silently took
-- every conversation it had ever carried, plus any mined knowledge, customer
-- memory and analytics from a history import.
--
-- Found while making offboard delete its rows: a number has to be removable so
-- that re-onboarding is treated as a fresh Coexistence connection rather than a
-- RECONNECT, and removing it must not cost the business its records.
--
-- Both columns are already nullable, so SetNull needs no data migration.

ALTER TABLE "conversations" DROP CONSTRAINT "conversations_channel_account_id_fkey";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_id_fkey"
    FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "historical_imports" DROP CONSTRAINT "historical_imports_channel_account_id_fkey";
ALTER TABLE "historical_imports" ADD CONSTRAINT "historical_imports_channel_account_id_fkey"
    FOREIGN KEY ("channel_account_id") REFERENCES "channel_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
