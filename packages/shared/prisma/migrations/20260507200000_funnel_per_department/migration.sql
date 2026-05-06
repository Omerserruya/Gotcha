-- Migration: funnel_per_department
-- Replace (tenantId × mode × funnelId) uniqueness with (tenantId × departmentId × funnelId).
-- NULL departmentId = tenant default funnel. Postgres 14+ compatible.

-- 1. Add department_id column (nullable — NULL = tenant default).
ALTER TABLE "tenant_funnels" ADD COLUMN "department_id" TEXT;

-- 2. Add FK constraint with ON DELETE SET NULL.
ALTER TABLE "tenant_funnels"
  ADD CONSTRAINT "tenant_funnels_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL;

-- 3. Data migration: for each (tenant_id, funnel_id) pair that has BOTH
--    mode='agent' and mode='copilot' rows, keep the agent row and delete
--    the copilot duplicate. For pairs with only one row, no action needed.
DELETE FROM "tenant_funnels" t1
WHERE t1.mode = 'copilot'
  AND EXISTS (
    SELECT 1 FROM "tenant_funnels" t2
    WHERE t2.tenant_id = t1.tenant_id
      AND t2.funnel_id = t1.funnel_id
      AND t2.mode = 'agent'
  );

-- 4. Drop old unique index on (tenant_id, mode, funnel_id).
DROP INDEX IF EXISTS "tenant_funnels_tenant_id_mode_funnel_id_key";

-- 5. Drop old index on (tenant_id, mode, is_active).
DROP INDEX IF EXISTS "tenant_funnels_tenant_id_mode_is_active_idx";

-- 6a. Partial unique index for the NULL-departmentId case (Postgres 14-compatible).
--     Ensures only one funnel_id per tenant when department_id IS NULL.
CREATE UNIQUE INDEX "tenant_funnels_tenant_id_null_dept_funnel_id_key"
  ON "tenant_funnels" ("tenant_id", "funnel_id")
  WHERE "department_id" IS NULL;

-- 6b. Regular unique index for the non-NULL department_id case.
CREATE UNIQUE INDEX "tenant_funnels_tenant_id_department_id_funnel_id_key"
  ON "tenant_funnels" ("tenant_id", "department_id", "funnel_id")
  WHERE "department_id" IS NOT NULL;

-- 7. Add new composite index on (tenant_id, department_id, is_active).
CREATE INDEX "tenant_funnels_tenant_id_department_id_is_active_idx"
  ON "tenant_funnels" ("tenant_id", "department_id", "is_active");

-- 8. Drop the mode column LAST (after all indexes referencing it are gone).
ALTER TABLE "tenant_funnels" DROP COLUMN "mode";
