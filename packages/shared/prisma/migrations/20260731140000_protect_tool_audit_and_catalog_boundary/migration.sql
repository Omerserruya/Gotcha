-- Protect the tool audit trail, and stop catalog edits reaching tenant data.
--
-- Three constraint changes, all in the same direction: a delete on one side of
-- the platform/tenant boundary must not silently destroy data on the other.
--
--   1. tool_executions.tenant_tool_id  Cascade -> SET NULL (+ nullable, + tool_name)
--      Disconnecting an integration deletes the tenant's tenant_tools rows.
--      Under Cascade that took the AI's execution history with it, so a
--      merchant clicking "Disconnect" erased the audit trail for everything
--      the AI had done through that integration.
--
--   2. tenant_integrations.integration_id  Cascade -> RESTRICT
--      Deleting a catalog entry deleted every tenant's connection to it -
--      credentials included.
--
--   3. tenant_tools.catalog_tool_id  Cascade -> RESTRICT
--      Same, one level down.
--
-- Idempotent and safe to re-run. Verified against dev before writing: 0 rows in
-- tool_executions, so the backfill below is a no-op there; it is written to be
-- correct on an estate that does have history.

BEGIN;

-- ── 1. tool_executions ──────────────────────────────────────────────────────

ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS tool_name TEXT NOT NULL DEFAULT '';

-- Backfill the denormalised name BEFORE the link can be broken, so existing
-- rows stay self-describing. Rows whose tool is already gone keep ''.
UPDATE tool_executions te
SET tool_name = ct.name
FROM tenant_tools tt
JOIN catalog_tools ct ON ct.id = tt.catalog_tool_id
WHERE te.tenant_tool_id = tt.id
  AND te.tool_name = '';

ALTER TABLE tool_executions ALTER COLUMN tenant_tool_id DROP NOT NULL;

DO $$
DECLARE fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'tool_executions'::regclass
    AND contype = 'f'
    AND confrelid = 'tenant_tools'::regclass;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tool_executions DROP CONSTRAINT %I', fk_name);
    EXECUTE format(
      'ALTER TABLE tool_executions ADD CONSTRAINT %I FOREIGN KEY (tenant_tool_id) '
      'REFERENCES tenant_tools(id) ON DELETE SET NULL ON UPDATE CASCADE', fk_name);
    RAISE NOTICE 'tool_executions.% -> ON DELETE SET NULL', fk_name;
  ELSE
    RAISE NOTICE 'tool_executions: no FK to tenant_tools found, nothing to change';
  END IF;
END $$;

-- ── 2. tenant_integrations -> integration_catalog ───────────────────────────

DO $$
DECLARE fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'tenant_integrations'::regclass
    AND contype = 'f'
    AND confrelid = 'integration_catalog'::regclass;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tenant_integrations DROP CONSTRAINT %I', fk_name);
    EXECUTE format(
      'ALTER TABLE tenant_integrations ADD CONSTRAINT %I FOREIGN KEY (integration_id) '
      'REFERENCES integration_catalog(id) ON DELETE RESTRICT ON UPDATE CASCADE', fk_name);
    RAISE NOTICE 'tenant_integrations.% -> ON DELETE RESTRICT', fk_name;
  END IF;
END $$;

-- ── 3. tenant_tools -> catalog_tools ────────────────────────────────────────

DO $$
DECLARE fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'tenant_tools'::regclass
    AND contype = 'f'
    AND confrelid = 'catalog_tools'::regclass;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tenant_tools DROP CONSTRAINT %I', fk_name);
    EXECUTE format(
      'ALTER TABLE tenant_tools ADD CONSTRAINT %I FOREIGN KEY (catalog_tool_id) '
      'REFERENCES catalog_tools(id) ON DELETE RESTRICT ON UPDATE CASCADE', fk_name);
    RAISE NOTICE 'tenant_tools.% -> ON DELETE RESTRICT', fk_name;
  END IF;
END $$;

-- ── Report the resulting state, so a run leaves evidence ────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS child,
           c.confrelid::regclass::text AS parent,
           CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                              WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                              WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.conrelid::regclass::text IN ('tool_executions','tenant_integrations','tenant_tools')
    ORDER BY 1, 2
  LOOP
    RAISE NOTICE 'AFTER: % -> % ON DELETE %', r.child, r.parent, r.on_delete;
  END LOOP;
END $$;

COMMIT;
