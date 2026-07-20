-- Shopify refund + order_lookup are now actually implemented in the adapter
-- (services/ai shopify.adapter.ts: process_refund via the REST refunds
-- calculate→create flow with gateway-transaction verification; order_lookup
-- as a get_order alias). Earlier catalog seeds for these slugs no longer
-- exist in live DBs, so seed idempotently.
INSERT INTO "catalog_tools" ("id","integration_id","slug","name","description","when_to_use","category","risk_level","is_default","sort_order","method","created_at") VALUES
('tool_shopify_process_refund', 'cat_shopify', 'process_refund', 'Process Refund', 'Refund a Shopify order - full by default, partial via amount or line items. Verified against the gateway transaction result.', 'Customer wants money back on an order (always behind approval).', 'ACTION', 'HIGH', true, 65, 'POST', CURRENT_TIMESTAMP),
('tool_shopify_order_lookup', 'cat_shopify', 'order_lookup', 'Order Lookup', 'Look up an order by id or name (alias of get_order).', 'Legacy alias - prefer get_order.', 'READ', 'LOW', true, 66, 'GET', CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id","slug") DO NOTHING;

-- Refund moves real money: always behind human approval, same policy as
-- cancel_order and the coupon creators.
UPDATE "catalog_tools"
SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60,"allowModification":true}'
WHERE "integration_id" = 'cat_shopify' AND "slug" = 'process_refund';

-- Backfill TenantTool rows for tenants that already connected Shopify, so the
-- new tools surface without a re-connect. Mirrors the connect-time seeding in
-- services/ai integrations route.
INSERT INTO "tenant_tools" ("id","tenant_id","tenant_integration_id","catalog_tool_id","is_enabled","config_overrides","created_at","updated_at")
SELECT
  ti.id || '_' || ct.slug,
  ti.tenant_id,
  ti.id,
  ct.id,
  true,
  '{}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tenant_integrations" ti
JOIN "catalog_tools" ct ON ct."integration_id" = ti."integration_id"
WHERE ti."integration_id" = 'cat_shopify'
  AND ct."slug" IN ('process_refund','order_lookup')
ON CONFLICT ("tenant_integration_id","catalog_tool_id") DO NOTHING;
