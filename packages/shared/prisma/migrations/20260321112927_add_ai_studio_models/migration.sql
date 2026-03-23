-- CreateEnum
CREATE TYPE "AIAgentMode" AS ENUM ('AUTONOMOUS', 'COPILOT', 'HUMAN_ONLY');

-- CreateEnum
CREATE TYPE "AIAgentStatus" AS ENUM ('ACTIVE', 'DRAFT', 'PAUSED');

-- CreateEnum
CREATE TYPE "RouterRuleRouteType" AS ENUM ('AI_AGENT', 'FLOW', 'HUMAN', 'DEPARTMENT');

-- DropForeignKey
ALTER TABLE "tenant_integrations" DROP CONSTRAINT "tenant_integrations_integration_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant_tools" DROP CONSTRAINT "tenant_tools_catalog_tool_id_fkey";

-- DropForeignKey
ALTER TABLE "tool_executions" DROP CONSTRAINT "tool_executions_tenant_tool_id_fkey";

-- DropIndex
DROP INDEX "agent_tool_permissions_tenant_tool_id_idx";

-- DropIndex
DROP INDEX "catalog_tools_category_idx";

-- DropIndex
DROP INDEX "integration_catalog_is_published_idx";

-- DropIndex
DROP INDEX "tenant_integrations_integration_id_idx";

-- DropIndex
DROP INDEX "tenant_integrations_status_idx";

-- DropIndex
DROP INDEX "tenant_tools_catalog_tool_id_idx";

-- DropIndex
DROP INDEX "tenant_tools_tenant_integration_id_idx";

-- AlterTable
ALTER TABLE "agent_tool_permissions" ADD COLUMN     "ai_agent_id" TEXT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "catalog_tools" ALTER COLUMN "category" SET DEFAULT 'READ';

-- AlterTable
ALTER TABLE "chatbot_flows" ADD COLUMN     "run_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trigger" TEXT;

-- AlterTable
ALTER TABLE "integration_catalog" ALTER COLUMN "auth_type" SET DEFAULT 'API_KEY',
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "knowledge_bases" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'all',
ADD COLUMN     "scope_agent_id" TEXT,
ADD COLUMN     "scope_department_id" TEXT;

-- AlterTable
ALTER TABLE "tenant_integrations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenant_tools" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'customer_support',
    "description" TEXT,
    "avatar_color" TEXT NOT NULL DEFAULT '#7c5cfc',
    "mode" "AIAgentMode" NOT NULL DEFAULT 'AUTONOMOUS',
    "status" "AIAgentStatus" NOT NULL DEFAULT 'DRAFT',
    "tone" TEXT NOT NULL DEFAULT 'professional',
    "languages" JSONB NOT NULL DEFAULT '{"english":true}',
    "style" JSONB NOT NULL DEFAULT '{}',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "escalation_rules" JSONB NOT NULL DEFAULT '[]',
    "interactive_messages" JSONB NOT NULL DEFAULT '{}',
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "identity" JSONB,
    "goals" JSONB,
    "tone_config" JSONB,
    "behavioral" JSONB,
    "max_autonomous_messages" INTEGER NOT NULL DEFAULT 10,
    "max_autonomous_minutes" INTEGER NOT NULL DEFAULT 15,
    "confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "escalation_message" TEXT NOT NULL DEFAULT 'Let me connect you with a team member who can help further.',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_knowledge" (
    "id" TEXT NOT NULL,
    "ai_agent_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "router_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "logic" TEXT NOT NULL DEFAULT 'AND',
    "route_type" "RouterRuleRouteType" NOT NULL,
    "route_target" TEXT,
    "ai_agent_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "router_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_agents_tenant_id_idx" ON "ai_agents"("tenant_id");

-- CreateIndex
CREATE INDEX "ai_agents_tenant_id_status_idx" ON "ai_agents"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ai_agent_knowledge_ai_agent_id_idx" ON "ai_agent_knowledge"("ai_agent_id");

-- CreateIndex
CREATE INDEX "ai_agent_knowledge_knowledge_base_id_idx" ON "ai_agent_knowledge"("knowledge_base_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_knowledge_ai_agent_id_knowledge_base_id_key" ON "ai_agent_knowledge"("ai_agent_id", "knowledge_base_id");

-- CreateIndex
CREATE INDEX "router_rules_tenant_id_idx" ON "router_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "router_rules_tenant_id_enabled_priority_idx" ON "router_rules"("tenant_id", "enabled", "priority");

-- CreateIndex
CREATE INDEX "agent_tool_permissions_agent_id_idx" ON "agent_tool_permissions"("agent_id");

-- CreateIndex
CREATE INDEX "agent_tool_permissions_ai_agent_id_idx" ON "agent_tool_permissions"("ai_agent_id");

-- CreateIndex
CREATE INDEX "integration_catalog_is_published_sort_order_idx" ON "integration_catalog"("is_published", "sort_order");

-- CreateIndex
CREATE INDEX "knowledge_bases_tenant_id_scope_idx" ON "knowledge_bases"("tenant_id", "scope");

-- CreateIndex
CREATE INDEX "tenant_integrations_tenant_id_status_idx" ON "tenant_integrations"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "tenant_tools_tenant_id_is_enabled_idx" ON "tenant_tools"("tenant_id", "is_enabled");

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge" ADD CONSTRAINT "ai_agent_knowledge_ai_agent_id_fkey" FOREIGN KEY ("ai_agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge" ADD CONSTRAINT "ai_agent_knowledge_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "router_rules" ADD CONSTRAINT "router_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "router_rules" ADD CONSTRAINT "router_rules_ai_agent_id_fkey" FOREIGN KEY ("ai_agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_integrations" ADD CONSTRAINT "tenant_integrations_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integration_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_tools" ADD CONSTRAINT "tenant_tools_catalog_tool_id_fkey" FOREIGN KEY ("catalog_tool_id") REFERENCES "catalog_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_tenant_tool_id_fkey" FOREIGN KEY ("tenant_tool_id") REFERENCES "tenant_tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "agent_tool_permissions_tenant_tool_id_department_id_agent_id_ke" RENAME TO "agent_tool_permissions_tenant_tool_id_department_id_agent_i_key";
