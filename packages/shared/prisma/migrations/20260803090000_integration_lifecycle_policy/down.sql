-- Rollback. Restores the previous cascade and drops the two lifecycle columns.
--
-- Note what rolling back re-enables: a CatalogTool deletion destroying tenant
-- policy. That is the pre-existing behaviour, so the rollback is faithful, but
-- it is not a safe resting state.
ALTER TABLE "tenant_integrations" DROP COLUMN IF EXISTS "disconnected_by";
ALTER TABLE "tenant_integrations" DROP COLUMN IF EXISTS "disconnected_at";

ALTER TABLE "tenant_tools" DROP CONSTRAINT IF EXISTS "tenant_tools_catalog_tool_id_fkey";
ALTER TABLE "tenant_tools"
  ADD CONSTRAINT "tenant_tools_catalog_tool_id_fkey"
  FOREIGN KEY ("catalog_tool_id") REFERENCES "catalog_tools"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
