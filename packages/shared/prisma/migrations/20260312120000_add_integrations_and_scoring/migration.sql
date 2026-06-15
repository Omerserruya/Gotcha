-- CreateTable: integrations
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT NOT NULL,
    "icon" TEXT,
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable: agent_scores
CREATE TABLE "agent_scores" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "response_quality" INTEGER,
    "response_speed" INTEGER,
    "resolution_score" INTEGER,
    "protocol_adherence" INTEGER,
    "customer_handling" INTEGER,
    "overall_score" DOUBLE PRECISION,
    "strengths" JSONB NOT NULL DEFAULT '[]',
    "improvements" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "copilot_usage_rate" DOUBLE PRECISION,
    "tools_used_count" INTEGER NOT NULL DEFAULT 0,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "analyzed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable: department_tool_permissions
CREATE TABLE "department_tool_permissions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_tool_permissions_pkey" PRIMARY KEY ("id")
);

-- AlterTable: tool_definitions - add integration_id
ALTER TABLE "tool_definitions" ADD COLUMN "integration_id" TEXT;

-- CreateIndex: integrations
CREATE UNIQUE INDEX "integrations_tenant_id_provider_key" ON "integrations"("tenant_id", "provider");
CREATE INDEX "integrations_tenant_id_idx" ON "integrations"("tenant_id");

-- CreateIndex: agent_scores
CREATE UNIQUE INDEX "agent_scores_conversation_id_agent_id_key" ON "agent_scores"("conversation_id", "agent_id");
CREATE INDEX "agent_scores_tenant_id_idx" ON "agent_scores"("tenant_id");
CREATE INDEX "agent_scores_agent_id_idx" ON "agent_scores"("agent_id");
CREATE INDEX "agent_scores_tenant_id_agent_id_idx" ON "agent_scores"("tenant_id", "agent_id");
CREATE INDEX "agent_scores_tenant_id_analyzed_at_idx" ON "agent_scores"("tenant_id", "analyzed_at");

-- CreateIndex: department_tool_permissions
CREATE UNIQUE INDEX "department_tool_permissions_department_id_tool_id_key" ON "department_tool_permissions"("department_id", "tool_id");
CREATE INDEX "department_tool_permissions_tenant_id_idx" ON "department_tool_permissions"("tenant_id");
CREATE INDEX "department_tool_permissions_department_id_idx" ON "department_tool_permissions"("department_id");

-- CreateIndex: tool_definitions integration_id
CREATE INDEX "tool_definitions_integration_id_idx" ON "tool_definitions"("integration_id");

-- AddForeignKey: tool_definitions -> integrations
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_integration_id_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: department_tool_permissions -> departments
ALTER TABLE "department_tool_permissions" ADD CONSTRAINT "department_tool_permissions_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: department_tool_permissions -> tool_definitions
ALTER TABLE "department_tool_permissions" ADD CONSTRAINT "department_tool_permissions_tool_id_fkey"
    FOREIGN KEY ("tool_id") REFERENCES "tool_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
