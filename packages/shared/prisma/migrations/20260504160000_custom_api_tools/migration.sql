CREATE TABLE "custom_api_tools" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "when_to_use" TEXT NOT NULL,
  "when_not_to_use" TEXT,
  "method" TEXT NOT NULL,
  "url_template" TEXT NOT NULL,
  "headers" JSONB NOT NULL DEFAULT '{}',
  "auth" JSONB NOT NULL DEFAULT '{"kind":"none"}',
  "secrets" TEXT,
  "parameters" JSONB NOT NULL DEFAULT '{"type":"object","properties":{},"required":[]}',
  "body_template" TEXT,
  "response_fields" JSONB,
  "allowed_hosts" JSONB NOT NULL DEFAULT '[]',
  "category" TEXT NOT NULL DEFAULT 'READ',
  "risk_level" TEXT NOT NULL DEFAULT 'MEDIUM',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_api_tools_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "custom_api_tools_tenant_id_slug_key" ON "custom_api_tools"("tenant_id", "slug");
CREATE INDEX "custom_api_tools_tenant_id_is_active_idx" ON "custom_api_tools"("tenant_id", "is_active");
