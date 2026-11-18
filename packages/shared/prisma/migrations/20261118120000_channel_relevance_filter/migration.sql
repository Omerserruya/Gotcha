-- The relevance filter per connected channel account (2026-11-18). Additive: one boolean, DEFAULT true, so
-- every existing account and every new one has the filter ON until the business turns it off. Ships with
-- 20261117220000_conversation_relevance.
ALTER TABLE "channel_accounts" ADD COLUMN "relevance_filter_enabled" BOOLEAN NOT NULL DEFAULT true;
