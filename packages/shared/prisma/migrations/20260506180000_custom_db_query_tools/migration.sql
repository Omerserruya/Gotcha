-- Custom DB query tools — tenant-defined SQL/Mongo queries the AI invokes
-- as `custom_db.<slug>`. Safer than generic CRUD because the admin defines
-- the exact shape; AI only fills in named params.

CREATE TABLE "custom_db_query_tools" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_slug" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "when_to_use" TEXT NOT NULL,
    "when_not_to_use" TEXT,
    "query_template" TEXT NOT NULL,
    "parameter_schema" JSONB NOT NULL DEFAULT '{"type":"object","properties":{},"required":[]}',
    "parameter_order" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT NOT NULL DEFAULT 'READ',
    "risk_level" TEXT NOT NULL DEFAULT 'LOW',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "max_rows" INTEGER NOT NULL DEFAULT 100,
    "timeout_ms" INTEGER NOT NULL DEFAULT 5000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_db_query_tools_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_db_query_tools_tenant_id_slug_key" ON "custom_db_query_tools"("tenant_id", "slug");
CREATE INDEX "custom_db_query_tools_tenant_id_is_active_idx" ON "custom_db_query_tools"("tenant_id", "is_active");
CREATE INDEX "custom_db_query_tools_tenant_id_provider_slug_idx" ON "custom_db_query_tools"("tenant_id", "provider_slug");
