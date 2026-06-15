-- System-language plumbing.
--
--   tenants.default_locale       - admin-set, applies to everyone in the org
--                                  who hasn't overridden their own.
--   users.locale                 - per-agent override; NULL means inherit
--                                  from tenants.default_locale.
--   conversations.detected_locale - auto-detected from the first inbound
--                                  message (heuristic + LLM fallback).
--                                  Drives suggested-reply language when
--                                  it should track the customer.
--
-- All three new columns are safe to add with defaults / NULL - no backfill
-- needed. The application code reads with fallbacks
-- (user.locale ?? tenant.default_locale ?? 'en').

ALTER TABLE "tenants"
  ADD COLUMN "default_locale" TEXT NOT NULL DEFAULT 'en';

ALTER TABLE "users"
  ADD COLUMN "locale" TEXT;

ALTER TABLE "conversations"
  ADD COLUMN "detected_locale" TEXT;
