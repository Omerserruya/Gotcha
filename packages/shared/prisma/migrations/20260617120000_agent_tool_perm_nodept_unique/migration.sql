-- Prevent duplicate department-less agent tool permissions.
--
-- The existing compound unique (tenant_tool_id, department_id, ai_agent_id) does
-- NOT prevent duplicates when department_id IS NULL, because Postgres treats
-- NULLs as distinct in unique indexes. A race (e.g. the wizard→editor save
-- firing twice) could therefore insert two identical permission rows, which then
-- render the same tool twice in the agent's tools UI and bloat the bot's tool
-- surface. This adds a PARTIAL unique index covering the department-less case.
--
-- Idempotent + non-destructive: dedupe existing rows first (keep earliest), then
-- create the index IF NOT EXISTS.

DELETE FROM "agent_tool_permissions" a USING (
  SELECT id, row_number() OVER (
    PARTITION BY ai_agent_id, tenant_tool_id, COALESCE(department_id, '')
    ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM "agent_tool_permissions"
) r
WHERE a.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_tool_perm_agent_tool_nodept_uniq"
  ON "agent_tool_permissions" ("ai_agent_id", "tenant_tool_id")
  WHERE "department_id" IS NULL;
