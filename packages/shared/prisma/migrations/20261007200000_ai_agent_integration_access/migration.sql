-- Per-employee allowlist of business systems (AIAgent.integrationAccess, see
-- packages/shared/src/lib/integration-access.ts). A system connected later is
-- off for every employee until turned on. Hand-written; the DDL is exactly
-- Prisma's schema-to-schema diff.

ALTER TABLE "ai_agents" ADD COLUMN     "integration_access" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill so nobody loses a system on deploy: every existing employee gets
-- every system its workspace has set up today, in ANY connection state (one
-- in error today is still the workspace's system and must work again when it
-- reconnects), plus every custom API tool and custom DB query ("custom:<id>").
UPDATE "ai_agents" a
SET "integration_access" = COALESCE((
  SELECT array_agg(k ORDER BY k) FROM (
    SELECT DISTINCT ic."slug" AS k
      FROM "tenant_integrations" ti
      JOIN "integration_catalog" ic ON ic."id" = ti."integration_id"
     WHERE ti."tenant_id" = a."tenant_id"
    UNION
    SELECT 'custom:' || c."id" FROM "custom_api_tools" c WHERE c."tenant_id" = a."tenant_id"
    UNION
    SELECT 'custom:' || d."id" FROM "custom_db_query_tools" d WHERE d."tenant_id" = a."tenant_id"
  ) keys
), ARRAY[]::TEXT[]);
