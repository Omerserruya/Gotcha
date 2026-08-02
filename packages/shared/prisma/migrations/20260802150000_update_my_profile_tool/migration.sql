-- A customer changing their own details, with ownership removed from the
-- model's reach entirely.
--
-- `update_customer` already existed and takes a customer selector. That is
-- correct for a human agent, who legitimately chooses whose record to edit,
-- and wrong for the autonomous customer surface, where the only safe answer to
-- "which customer?" is "the authenticated one, and the question is not open".
--
-- So `update_my_profile` has NO customer_id, email or phone selector in its
-- schema. customer-access-guard.ts derives the record from the channel
-- identity and strips anything selector-shaped the model sent. A model cannot
-- get ownership wrong when ownership is not one of its arguments.
INSERT INTO "catalog_tools" (
  id, integration_id, slug, name, description, category,
  input_schema, output_schema, endpoint, method, is_default, risk_level,
  sort_order, created_at, when_to_use, allowed_modes, schema_version
)
SELECT
  'ctool_update_my_profile', ic.id, 'update_my_profile', 'Update my profile',
  'Update the CURRENT customer''s own Shopify profile: name, email, phone and default address, then read it back.',
  'WRITE',
  '{"type":"object","properties":{"first_name":{"type":"string"},"last_name":{"type":"string"},"email":{"type":"string"},"phone":{"type":"string"},"address":{"type":"object"}}}'::jsonb,
  '{}'::jsonb,
  NULL, 'PUT', false, 'MEDIUM', 190, now(),
  'The customer asks to change their own details. Never ask for a customer id - the system knows who they are.',
  '["AUTO","ASSIST"]'::jsonb, 1
FROM "integration_catalog" ic
WHERE ic.slug = 'shopify'
  AND NOT EXISTS (SELECT 1 FROM "catalog_tools" x WHERE x.integration_id = ic.id AND x.slug = 'update_my_profile');

-- Same backfill as the previous migration: a catalog row reaches no assistant
-- until a TenantTool and an AgentToolPermission exist for it.
WITH new_tools AS (
  SELECT ct.id AS catalog_tool_id, ic.id AS integration_id
  FROM "catalog_tools" ct
  JOIN "integration_catalog" ic ON ic.id = ct."integration_id"
  WHERE ic.slug = 'shopify' AND ct.slug = 'update_my_profile'
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
WHERE ic.slug = 'shopify' AND ct.slug = 'update_my_profile'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_tool_permissions" x
    WHERE x."tenant_tool_id" = tt.id AND x."ai_agent_id" = a.id
  );
