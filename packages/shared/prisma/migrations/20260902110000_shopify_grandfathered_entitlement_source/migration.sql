-- A distinct entitlement source for grandfathered Shopify access.
--
-- WHY NOT REUSE 'SHOPIFY_SUBSCRIPTION'
-- ------------------------------------
-- The two grants end for different reasons. A subscription-funded entitlement
-- ends when Shopify stops charging; a grandfathered one ends only when the
-- store is uninstalled or an admin revokes the grant. `revokeShopifyEntitlements`
-- deletes by source, so one value covering both would mean any code path that
-- revoked "what Shopify paid for" also cut off the merchants who were promised
-- they would never have to pay.
--
-- Separate migration from 20260902100000 because that one is already applied;
-- editing it would change its checksum and put every environment into drift.
--
-- ADDITIVE. Adding an enum value cannot break an existing row.

ALTER TYPE "EntitlementSource" ADD VALUE IF NOT EXISTS 'SHOPIFY_GRANDFATHERED';

-- ─── Reversal ─────────────────────────────────────────────────────────────
-- Postgres cannot drop an enum value. This one is inert while unused, so the
-- reversal is to stop writing it rather than to rebuild the type:
--
--   DELETE FROM "tenant_entitlements" WHERE "source" = 'SHOPIFY_GRANDFATHERED';
