-- MCP servers a tenant connects; a SYSTEM_ADMIN approves each. Additive only.
-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "auth_kind" TEXT NOT NULL DEFAULT 'none',
    "auth_header_name" TEXT,
    "secrets" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "reject_reason" TEXT,
    "last_error" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "discovered_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_servers_status_created_at_idx" ON "mcp_servers"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_servers_tenant_id_slug_key" ON "mcp_servers"("tenant_id", "slug");

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

