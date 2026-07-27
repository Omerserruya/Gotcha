-- Shopify Live Chat channel — ADDITIVE ONLY.
--
-- Adds one value to the ChannelType enum. Nothing else is needed: the
-- channel reuses ChannelAccount (public key in external_id, config in
-- platform_meta), Conversation, and Message. Structured commerce
-- messages ride on Message.message_type + Message.metadata, which are
-- already free-form.
--
-- Existing Live Channel rows (WEBCHAT and every other type) are
-- untouched, and no tenant is auto-enrolled: a merchant must explicitly
-- create a SHOPIFY_LIVE_CHAT ChannelAccount.
--
-- `IF NOT EXISTS` keeps this idempotent so it is safe to re-run against a
-- box where the value was hot-patched.

ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'SHOPIFY_LIVE_CHAT';
