-- Tenant tool policy must outlive the connection it was configured through.
--
-- Two independent routes destroyed it, and one of them fired on an ordinary
-- operator action:
--
--   1. `POST /:slug/disconnect` ran an explicit `tenantTool.deleteMany`. An
--      operator who disabled `process_refund`, disconnected to re-grant scopes,
--      and reconnected got the tool back ENABLED. Their decision was not
--      overridden - the evidence of it was deleted.
--   2. `CatalogTool -> TenantTool` was ON DELETE CASCADE, so a PLATFORM-side
--      catalogue edit silently destroyed every tenant's policy for that tool,
--      plus their per-agent permissions and their execution history.
--
-- Route 1 is fixed in application code (disconnect is a state transition now).
-- Route 2 is fixed here, because no amount of care in the application can stop
-- a foreign key from doing what it was declared to do.
--
-- REVERSIBILITY: both changes are metadata-only. No row is created, deleted or
-- rewritten. The rollback is in the companion `down.sql`, and running it
-- restores the previous constraint exactly.

-- ── 1. A platform catalogue edit may no longer delete tenant policy ──────────
ALTER TABLE "tenant_tools" DROP CONSTRAINT IF EXISTS "tenant_tools_catalog_tool_id_fkey";
ALTER TABLE "tenant_tools"
  ADD CONSTRAINT "tenant_tools_catalog_tool_id_fkey"
  FOREIGN KEY ("catalog_tool_id") REFERENCES "catalog_tools"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2. Disconnect is a state transition, so it has a time and an actor ───────
-- Nullable with no default: existing rows are genuinely unknown, and back-
-- filling a timestamp would invent a disconnect that never happened.
ALTER TABLE "tenant_integrations" ADD COLUMN IF NOT EXISTS "disconnected_at" TIMESTAMP(3);
ALTER TABLE "tenant_integrations" ADD COLUMN IF NOT EXISTS "disconnected_by" TEXT;
