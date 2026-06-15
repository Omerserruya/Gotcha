-- Reconcile schema drift: ADDITIVE, non-destructive columns only.
--
-- These columns exist in schema.prisma but had no migration, so the
-- migration-driven production DB was missing them. Symptom: Prisma P2022
-- "column users.onboarding_guides does not exist" crashing /api/auth/login.
--
-- IF NOT EXISTS keeps this idempotent: safe to run even if a column was
-- already hot-patched manually on a box.
--
-- DELIBERATELY EXCLUDED (destructive drift - handle separately, with review):
--   * DROP TABLE copilot_configs / department_copilot_configs / first_take_care_configs (data loss)
--   * ALTER contacts.tags / opt_out_channels SET NOT NULL (fails on existing NULLs)
--   * CREATE UNIQUE INDEX tenant_funnels_tenant_id_department_id_funnel_id_key (fails on dup data)
--   * assorted FK onDelete changes / index renames (not required for the app to run)

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_guides" JSONB;

ALTER TABLE "agent_tool_permissions" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "agent_tool_permissions" ADD COLUMN IF NOT EXISTS "usage_rule" TEXT;

ALTER TABLE "business_profiles" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "business_profiles" ADD COLUMN IF NOT EXISTS "primary_language" TEXT;
ALTER TABLE "business_profiles" ADD COLUMN IF NOT EXISTS "primary_system" TEXT;
