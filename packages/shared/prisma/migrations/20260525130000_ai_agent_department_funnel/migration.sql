-- Per-agent department + funnel binding.
--
-- Until now the agent had no department or funnel column - funnel resolution
-- worked off (voiceChannel override → conversation.departmentId → tenant
-- default). The frontend already exposes a department selector on the agent
-- editor, but the submitted value was silently dropped because the column
-- didn't exist. This migration:
--
--   1. Adds `ai_agents.department_id` (nullable TEXT) FK → departments.id
--      with SetNull-on-delete. NULL means "tenant-wide" (no dept binding).
--   2. Adds `ai_agents.funnel_id` (nullable TEXT) FK → tenant_funnels.id
--      with SetNull-on-delete. NULL means "fall through to the next layer
--      in the resolver chain" (channel override → dept → tenant default).
--   3. Indexes both for the resolver lookup.
--
-- Both columns are nullable with no defaults - existing agents keep working
-- (they just fall through the resolver chain as before).

ALTER TABLE "ai_agents"
  ADD COLUMN "department_id" TEXT,
  ADD COLUMN "funnel_id"     TEXT;

ALTER TABLE "ai_agents"
  ADD CONSTRAINT "ai_agents_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL;

ALTER TABLE "ai_agents"
  ADD CONSTRAINT "ai_agents_funnel_id_fkey"
    FOREIGN KEY ("funnel_id") REFERENCES "tenant_funnels"("id") ON DELETE SET NULL;

CREATE INDEX "ai_agents_tenant_id_department_id_idx"
  ON "ai_agents" ("tenant_id", "department_id");

CREATE INDEX "ai_agents_tenant_id_funnel_id_idx"
  ON "ai_agents" ("tenant_id", "funnel_id");
