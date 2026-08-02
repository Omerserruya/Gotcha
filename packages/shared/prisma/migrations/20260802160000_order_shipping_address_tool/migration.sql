-- Changing where an order is going, which is only possible before it goes.
--
-- Kept separate from `update_my_profile` deliberately: a customer's SAVED
-- address and an ORDER's shipping address are different objects with different
-- consequences, and a customer who has moved usually wants both. Conflating
-- them silently changes one and reports the other.
--
-- Eligibility is decided from FULFILLMENT ORDERS, never from
-- `order.fulfillment_status` - the field that reported `null` for #1006 while
-- Shopify refused to cancel it for having outstanding fulfillments. Deciding
-- "has this left yet" from the legacy field is confidently wrong on exactly
-- the orders where being wrong sends a parcel to the old address.
INSERT INTO "catalog_tools" (
  id, integration_id, slug, name, description, category,
  input_schema, output_schema, endpoint, method, is_default, risk_level,
  sort_order, created_at, when_to_use, allowed_modes, schema_version
) VALUES (
  'ctool_update_order_shipping_address', 'cat_shopify', 'update_order_shipping_address',
  'Change order shipping address',
  'Change the shipping address of an order that has NOT been dispatched, then read the order back and verify it.',
  'ACTION',
  '{"type":"object","properties":{"order_id":{"type":"string"},"order_name":{"type":"string"},"address":{"type":"object"}}}'::jsonb,
  '{}'::jsonb,
  NULL, 'PUT', false, 'HIGH', 200, now(),
  'Customer asks to change where an existing order is being sent. Refuses once fulfillment has started - never claim the address changed or that a carrier was contacted.',
  '["AUTO","ASSIST"]'::jsonb, 1
)
ON CONFLICT ("integration_id","slug") DO NOTHING;

-- Redirecting a placed order is a HIGH-risk mutation a person should see: the
-- approval card carries the order, the old and new city/country, the exact
-- changed fields and the fulfillment state.
UPDATE "catalog_tools"
SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60,"allowModification":true}'
WHERE "integration_id" = 'cat_shopify' AND "slug" = 'update_order_shipping_address';

-- Activate + permission it, which a catalog row alone does not do.
INSERT INTO "tenant_tools" (id, tenant_id, tenant_integration_id, catalog_tool_id, is_enabled, config_overrides, created_at, updated_at)
SELECT
  'tt_' || substr(md5(ti.id || ct.id), 1, 24),
  ti."tenant_id", ti.id, ct.id, true, '{}'::jsonb, now(), now()
FROM "tenant_integrations" ti
JOIN "catalog_tools" ct ON ct."integration_id" = ti."integration_id"
WHERE ti."integration_id" = 'cat_shopify'
  AND ti.status = 'CONNECTED'
  AND ct."slug" = 'update_order_shipping_address'
ON CONFLICT ("tenant_integration_id","catalog_tool_id") DO NOTHING;

INSERT INTO "agent_tool_permissions" (id, tenant_id, ai_agent_id, tenant_tool_id, is_allowed, require_approval, created_at, updated_at)
SELECT
  'atp_' || substr(md5(a.id || tt.id), 1, 24),
  tt."tenant_id", a.id, tt.id, true, false, now(), now()
FROM "tenant_tools" tt
JOIN "catalog_tools" ct ON ct.id = tt."catalog_tool_id"
JOIN "ai_agents" a ON a."tenant_id" = tt."tenant_id"
WHERE ct."integration_id" = 'cat_shopify' AND ct."slug" = 'update_order_shipping_address'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_tool_permissions" x
    WHERE x."tenant_tool_id" = tt.id AND x."ai_agent_id" = a.id
  );
