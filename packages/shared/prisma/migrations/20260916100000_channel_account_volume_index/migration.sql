-- Per-ACCOUNT conversation volume for the Channels screen.
--
-- Grouping conversations by channel TYPE has always been cheap because
-- (tenant_id, channel, customer_external_id) exists. Grouping by ACCOUNT had
-- no index at all, and account is the unit the screen actually renders: a
-- tenant with two WhatsApp numbers has to see them counted apart rather than
-- given the same combined figure twice.
--
-- CONCURRENTLY is deliberately NOT used. Prisma wraps each migration in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one. The table
-- is locked for the duration of the build, which is acceptable at current
-- volume; if that stops being true this should be rebuilt out-of-band rather
-- than made concurrent here.
CREATE INDEX "conversations_tenant_id_channel_account_id_idx"
  ON "conversations"("tenant_id", "channel_account_id");
