-- A missing-item complaint is arithmetic, and there was no tool that did it.
--
-- Scenario 25 (2026-08-01): a customer reported a missing item from his own
-- order, on the WhatsApp number stored on that order, and the reply asked him
-- to verify his identity. The turn never read a quantity, because reading a
-- quantity meant stitching together `line_items`, `fulfillments`, the
-- fulfillment orders and the refunds - four shapes, three of them optional -
-- and nothing in the surface did that.
--
-- `reconcile_order_items` returns the whole comparison in one call, including
-- which item (if any) the complaint can only be about. That last field is what
-- stops the model asking "which item is missing?" on a one-item order.
INSERT INTO "catalog_tools" (
  id, integration_id, slug, name, description, category,
  input_schema, output_schema, endpoint, method, is_default, risk_level,
  sort_order, created_at, when_to_use, allowed_modes, schema_version
)
SELECT
  'ctool_reconcile_order_items', ic.id, 'reconcile_order_items', 'Reconcile order items',
  'Compare what was ORDERED against what was actually shipped, still pending, cancelled or refunded, line by line.',
  'READ',
  '{"type":"object","properties":{"order_id":{"type":"string"},"order_name":{"type":"string"}}}'::jsonb,
  '{}'::jsonb,
  NULL, 'GET', false, 'LOW', 180, now(),
  'Customer says something is missing or short from an order. Call this BEFORE asking which item they mean and without asking them to verify their identity again.',
  '["AUTO","ASSIST"]'::jsonb, 1
FROM "integration_catalog" ic
WHERE ic.slug = 'shopify'
  AND NOT EXISTS (SELECT 1 FROM "catalog_tools" x WHERE x.integration_id = ic.id AND x.slug = 'reconcile_order_items');

-- Backfill: a new catalog tool reaches nobody on its own.
--
-- The tool surface is built from AgentToolPermission rows, and those are only
-- created when an integration is CONNECTED (or the CRM toggle is flipped). A
-- tool added by migration is therefore invisible to every tenant that
-- connected Shopify before today - including the dev store this was written
-- for. That is the same class of failure as the reconnect defect in Part 3:
-- the connection is healthy, the catalog is correct, and the assistant cannot
-- see the tool.
--
-- So the migration provisions its own row the way a connect would: a
-- TenantTool for every connected Shopify integration, and an
-- AgentToolPermission for every AI employee of that tenant. `add_order_note`
-- is included because it shipped one migration earlier with the same gap.
--
-- Idempotent by NOT EXISTS, and it never re-enables anything: rows an operator
-- turned off are untouched because they already exist.
WITH new_tools AS (
  SELECT ct.id AS catalog_tool_id, ic.id AS integration_id
  FROM "catalog_tools" ct
  JOIN "integration_catalog" ic ON ic.id = ct."integration_id"
  WHERE ic.slug = 'shopify' AND ct.slug IN ('reconcile_order_items', 'add_order_note')
),
connected AS (
  SELECT ti.id AS tenant_integration_id, ti."tenant_id", nt.catalog_tool_id
  FROM "tenant_integrations" ti
  JOIN new_tools nt ON nt.integration_id = ti."integration_id"
  WHERE ti.status = 'CONNECTED'
)
INSERT INTO "tenant_tools" (id, tenant_id, tenant_integration_id, catalog_tool_id, is_enabled, config_overrides, created_at, updated_at)
SELECT
  'tt_' || substr(md5(c.tenant_integration_id || c.catalog_tool_id), 1, 24),
  c."tenant_id", c.tenant_integration_id, c.catalog_tool_id, true, '{}'::jsonb, now(), now()
FROM connected c
WHERE NOT EXISTS (
  SELECT 1 FROM "tenant_tools" x
  WHERE x."tenant_integration_id" = c.tenant_integration_id AND x."catalog_tool_id" = c.catalog_tool_id
);

INSERT INTO "agent_tool_permissions" (id, tenant_id, ai_agent_id, tenant_tool_id, is_allowed, require_approval, created_at, updated_at)
SELECT
  'atp_' || substr(md5(a.id || tt.id), 1, 24),
  tt."tenant_id", a.id, tt.id, true, false, now(), now()
FROM "tenant_tools" tt
JOIN "catalog_tools" ct ON ct.id = tt."catalog_tool_id"
JOIN "integration_catalog" ic ON ic.id = ct."integration_id"
JOIN "ai_agents" a ON a."tenant_id" = tt."tenant_id"
WHERE ic.slug = 'shopify'
  AND ct.slug IN ('reconcile_order_items', 'add_order_note')
  AND NOT EXISTS (
    SELECT 1 FROM "agent_tool_permissions" x
    WHERE x."tenant_tool_id" = tt.id AND x."ai_agent_id" = a.id
  );
