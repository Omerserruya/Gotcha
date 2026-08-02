-- The tool that did not exist.
--
-- Part 3's scope matrix recorded `write_returns` as "granted but no tool uses
-- it", and scenario 21 was UNSUPPORTED for exactly that reason: the store could
-- read every RMA it had and open none. Both candidate providers were connected
-- and neither could create a return - ReturnGO's adapter exposes list, summarise
-- and update, with no create at all.
--
-- `returnCreate` is GraphQL-only and works against FULFILLMENT line items
-- rather than order line items. That is not a quirk to route around: an item
-- that never shipped has nothing to return, and the API saying so is more
-- correct than a tool that would open an RMA for a parcel still in the
-- warehouse.
INSERT INTO "catalog_tools" (
  id, integration_id, slug, name, description, category,
  input_schema, output_schema, endpoint, method, is_default, risk_level,
  sort_order, created_at, when_to_use, allowed_modes, schema_version
) VALUES (
  'ctool_create_return', 'cat_shopify', 'create_return', 'Create return (RMA)',
  'Open a Shopify Return against an order''s fulfilled line items, then read it back and report the real return id.',
  'ACTION',
  '{"type":"object","properties":{"order_id":{"type":"string"},"order_name":{"type":"string"},"line_items":{"type":"array"},"note":{"type":"string"}}}'::jsonb,
  '{}'::jsonb,
  NULL, 'POST', false, 'HIGH', 202, now(),
  'Customer wants to return something delivered and Shopify is this store''s return provider. Never open a second return for items already covered by one.',
  '["AUTO","ASSIST"]'::jsonb, 1
)
ON CONFLICT ("integration_id","slug") DO NOTHING;

UPDATE "catalog_tools"
SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60,"allowModification":true}'
WHERE "integration_id" = 'cat_shopify' AND "slug" = 'create_return';

INSERT INTO "tenant_tools" (id, tenant_id, tenant_integration_id, catalog_tool_id, is_enabled, config_overrides, created_at, updated_at)
SELECT
  'tt_' || substr(md5(ti.id || ct.id), 1, 24),
  ti."tenant_id", ti.id, ct.id, true, '{}'::jsonb, now(), now()
FROM "tenant_integrations" ti
JOIN "catalog_tools" ct ON ct."integration_id" = ti."integration_id"
WHERE ti."integration_id" = 'cat_shopify' AND ti.status = 'CONNECTED'
  AND ct."slug" = 'create_return'
ON CONFLICT ("tenant_integration_id","catalog_tool_id") DO NOTHING;

INSERT INTO "agent_tool_permissions" (id, tenant_id, ai_agent_id, tenant_tool_id, is_allowed, require_approval, created_at, updated_at)
SELECT
  'atp_' || substr(md5(a.id || tt.id), 1, 24),
  tt."tenant_id", a.id, tt.id, true, false, now(), now()
FROM "tenant_tools" tt
JOIN "catalog_tools" ct ON ct.id = tt."catalog_tool_id"
JOIN "ai_agents" a ON a."tenant_id" = tt."tenant_id"
WHERE ct."integration_id" = 'cat_shopify' AND ct."slug" = 'create_return'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_tool_permissions" x
    WHERE x."tenant_tool_id" = tt.id AND x."ai_agent_id" = a.id
  );
