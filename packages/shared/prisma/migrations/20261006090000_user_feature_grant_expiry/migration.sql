-- A per-person permission can end: 7 days, 30 days, or a picked date (12e).
--
-- Nullable and additive: every existing row keeps meaning "no end date".
-- Expiry is enforced at read time by the permission resolver, so there is no
-- sweeper and an expired row stays visible as history until someone removes it.
ALTER TABLE "user_feature_grants" ADD COLUMN "expires_at" TIMESTAMP(3);
