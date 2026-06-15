-- Fireberry (formerly Powerlink) integration: Israeli CRM (API-token auth).
-- Catalog-driven, so the marketplace + generic API_KEY connect flow pick it up.
-- Category CRM → eligible as a source-of-truth core system. Idempotent.

-- ── Catalog entry ──
INSERT INTO "integration_catalog"
  ("id", "slug", "name", "description", "category", "auth_type", "auth_schema", "is_published", "sort_order", "created_at", "updated_at")
VALUES
  ('cat_fireberry', 'fireberry', 'Fireberry',
   'Israeli CRM (formerly Powerlink) - accounts, contacts and leads as your source of truth.',
   'CRM', 'API_KEY',
   '{"required":["tokenid"],"fields":[{"key":"tokenid","label":"API Token","type":"password","required":true,"helpText":"Fireberry → Settings → Integration → API Forms → My Token."}]}',
   true, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "auth_type" = EXCLUDED."auth_type",
  "auth_schema" = EXCLUDED."auth_schema",
  "is_published" = true;

-- ── Tools ──
-- READ tools are default-enabled on connect; WRITE tools are opt-in by risk.
INSERT INTO "catalog_tools"
  ("id", "integration_id", "slug", "name", "description", "when_to_use", "category", "risk_level", "is_default", "sort_order", "method", "created_at")
VALUES
  ('tool_fireberry_query_records', 'cat_fireberry', 'query_records', 'Query Records',
   'Query Fireberry records of an object type, filtered by a field expression.',
   'You need to find an account/contact by a field such as email or phone.',
   'READ', 'LOW', true, 1, 'POST', CURRENT_TIMESTAMP),
  ('tool_fireberry_get_record', 'cat_fireberry', 'get_record', 'Get Record',
   'Get a single Fireberry record by id.',
   'You already have a record GUID and need its fields.',
   'READ', 'LOW', true, 2, 'GET', CURRENT_TIMESTAMP),
  ('tool_fireberry_create_record', 'cat_fireberry', 'create_record', 'Create Record',
   'Create a single record (account/contact/lead) in Fireberry.',
   'A new customer contacted you and does not exist in Fireberry yet.',
   'WRITE', 'MEDIUM', true, 3, 'POST', CURRENT_TIMESTAMP),
  ('tool_fireberry_update_record', 'cat_fireberry', 'update_record', 'Update Record',
   'Patch fields (e.g. notes, phone, email) on an existing Fireberry record.',
   'You need to enrich or annotate an existing record.',
   'WRITE', 'LOW', true, 4, 'PUT', CURRENT_TIMESTAMP)
ON CONFLICT ("integration_id", "slug") DO NOTHING;
