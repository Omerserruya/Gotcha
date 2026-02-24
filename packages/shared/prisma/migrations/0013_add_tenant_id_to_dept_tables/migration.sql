-- Add tenant_id to department_members (populated from department's tenant_id)
ALTER TABLE "department_members" ADD COLUMN "tenant_id" TEXT;
UPDATE "department_members" SET "tenant_id" = d."tenant_id" FROM "departments" d WHERE "department_members"."department_id" = d."id";
ALTER TABLE "department_members" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "department_members_tenant_id_idx" ON "department_members"("tenant_id");

-- Add tenant_id to agent_configs (populated from department's tenant_id)
ALTER TABLE "agent_configs" ADD COLUMN "tenant_id" TEXT;
UPDATE "agent_configs" SET "tenant_id" = d."tenant_id" FROM "departments" d WHERE "agent_configs"."department_id" = d."id";
ALTER TABLE "agent_configs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "agent_configs_tenant_id_idx" ON "agent_configs"("tenant_id");

-- Add tenant_id to department_copilot_configs (populated from department's tenant_id)
ALTER TABLE "department_copilot_configs" ADD COLUMN "tenant_id" TEXT;
UPDATE "department_copilot_configs" SET "tenant_id" = d."tenant_id" FROM "departments" d WHERE "department_copilot_configs"."department_id" = d."id";
ALTER TABLE "department_copilot_configs" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "department_copilot_configs" ADD CONSTRAINT "department_copilot_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "department_copilot_configs_tenant_id_idx" ON "department_copilot_configs"("tenant_id");
