-- Swapping a line item for a different variant, before anything ships.
--
-- Narrower than the existing `edit_order` on purpose. A general order editor in
-- a customer conversation is a way to rewrite someone's order by accident;
-- `exchange_order_item` can only ever swap one thing the customer already
-- bought for another thing in the same shop.
--
-- The money is what keeps it narrow. A Shopify order edit does not settle
-- itself: a dearer variant leaves the order owing, a cheaper one leaves the
-- shop owing, and no customer-facing payment flow exists here to close either
-- gap. Both are refused BEFORE the edit begins rather than after, because an
-- aborted order edit is worse than none - and the alternative, committing and
-- then chaining a refund, would invent a compensation mechanism out of two
-- separate approvals.
INSERT INTO "catalog_tools" (
  id, integration_id, slug, name, description, category,
  input_schema, output_schema, endpoint, method, is_default, risk_level,
  sort_order, created_at, when_to_use, allowed_modes, schema_version
) VALUES (
  'ctool_exchange_order_item', 'cat_shopify', 'exchange_order_item',
  'Exchange an order item',
  'Replace one line item on an UNDISPATCHED order with a different variant, then read the order back and verify both sides of the swap.',
  'ACTION',
  '{"type":"object","properties":{"order_id":{"type":"string"},"order_name":{"type":"string"},"line_item_id":{"type":"string"},"current_variant_id":{"type":"string"},"new_variant_id":{"type":"string"},"quantity":{"type":"number"}}}'::jsonb,
  '{}'::jsonb,
  NULL, 'POST', false, 'HIGH', 201, now(),
  'Customer wants a different size, colour or variant of something not yet shipped. Refuses when the price differs or fulfillment has started.',
  '["AUTO","ASSIST"]'::jsonb, 1
)
ON CONFLICT ("integration_id","slug") DO NOTHING;

-- Rewriting what a placed order contains is a HIGH-risk mutation a person
-- approves, with the exact before/after variants and the price difference on
-- the card.
UPDATE "catalog_tools"
SET "hitl_policy" = '{"mode":"always","approverRole":"ADMIN","notifyChannels":["in_app"],"expiresAfterMin":60,"allowModification":true}'
WHERE "integration_id" = 'cat_shopify' AND "slug" = 'exchange_order_item';

INSERT INTO "tenant_tools" (id, tenant_id, tenant_integration_id, catalog_tool_id, is_enabled, config_overrides, created_at, updated_at)
SELECT
  'tt_' || substr(md5(ti.id || ct.id), 1, 24),
  ti."tenant_id", ti.id, ct.id, true, '{}'::jsonb, now(), now()
FROM "tenant_integrations" ti
JOIN "catalog_tools" ct ON ct."integration_id" = ti."integration_id"
WHERE ti."integration_id" = 'cat_shopify' AND ti.status = 'CONNECTED'
  AND ct."slug" = 'exchange_order_item'
ON CONFLICT ("tenant_integration_id","catalog_tool_id") DO NOTHING;

INSERT INTO "agent_tool_permissions" (id, tenant_id, ai_agent_id, tenant_tool_id, is_allowed, require_approval, created_at, updated_at)
SELECT
  'atp_' || substr(md5(a.id || tt.id), 1, 24),
  tt."tenant_id", a.id, tt.id, true, false, now(), now()
FROM "tenant_tools" tt
JOIN "catalog_tools" ct ON ct.id = tt."catalog_tool_id"
JOIN "ai_agents" a ON a."tenant_id" = tt."tenant_id"
WHERE ct."integration_id" = 'cat_shopify' AND ct."slug" = 'exchange_order_item'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_tool_permissions" x
    WHERE x."tenant_tool_id" = tt.id AND x."ai_agent_id" = a.id
  );
