-- ============================================================
-- Surface Custom API tools as a connectionless marketplace tile.
--
-- The cat_custom_api row already exists from earlier migrations
-- (20260312150000) but carries stale generic http_get/http_post/...
-- catalog_tools that shadow the real per-tenant `custom.<slug>` tools
-- exposed by CustomApiToolsSection. It also has API_KEY auth_type +
-- a baseUrl field, which forces the integration page to render a
-- credentials form for an integration that has no central token.
--
-- This migration:
--   1) Re-tags the row as auth_type=CUSTOM with an empty auth_schema,
--      so the page hides the connect form and goes straight to the
--      Postman-style tool builder.
--   2) Drops the legacy http_* catalog tools that never had an adapter
--      backing them.
-- ============================================================

UPDATE "integration_catalog" SET
  "auth_type" = 'CUSTOM',
  "auth_schema" = '{}',
  "config_schema" = '{}',
  "description" = 'Define your own HTTP tools — Postman-style request builder. Each tool exposes one API call to the AI as custom.<slug>.',
  "is_published" = true,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'custom_api';

DELETE FROM "catalog_tools"
WHERE "integration_id" = 'cat_custom_api';

-- Safety net: insert the row if a fresh DB never had it (cat_custom_api
-- was added in 20260312150000, but keep this idempotent).
INSERT INTO "integration_catalog" (
  "id", "slug", "name", "description",
  "category", "auth_type", "auth_schema", "config_schema",
  "is_published", "sort_order",
  "created_at", "updated_at"
) VALUES (
  'cat_custom_api',
  'custom_api',
  'Custom API',
  'Define your own HTTP tools — Postman-style request builder. Each tool exposes one API call to the AI as custom.<slug>.',
  'CUSTOM',
  'CUSTOM',
  '{}',
  '{}',
  true,
  999,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO NOTHING;
