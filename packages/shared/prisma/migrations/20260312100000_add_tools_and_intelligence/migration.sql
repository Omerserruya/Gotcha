-- CreateEnum
CREATE TYPE "ToolType" AS ENUM ('CRM', 'ECOMMERCE', 'KNOWLEDGE_BASE', 'INTERNAL_API', 'CUSTOM');

-- CreateTable
CREATE TABLE "tool_definitions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tool_type" "ToolType" NOT NULL DEFAULT 'CUSTOM',
    "provider" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "input_schema" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_executions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "success" BOOLEAN NOT NULL DEFAULT true,
    "duration_ms" INTEGER,
    "triggered_by" TEXT NOT NULL DEFAULT 'ai',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_intelligence" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "summary" TEXT,
    "detected_intent" TEXT,
    "intent_confidence" DOUBLE PRECISION,
    "sentiment" TEXT,
    "sentiment_score" DOUBLE PRECISION,
    "topics" JSONB NOT NULL DEFAULT '[]',
    "tools_used" JSONB NOT NULL DEFAULT '[]',
    "resolution_outcome" TEXT,
    "customer_effort" INTEGER,
    "ai_confidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "analyzed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_intelligence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_definitions_tenant_id_idx" ON "tool_definitions"("tenant_id");
CREATE UNIQUE INDEX "tool_definitions_tenant_id_name_key" ON "tool_definitions"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "tool_executions_tenant_id_idx" ON "tool_executions"("tenant_id");
CREATE INDEX "tool_executions_conversation_id_idx" ON "tool_executions"("conversation_id");
CREATE INDEX "tool_executions_tool_id_idx" ON "tool_executions"("tool_id");
CREATE INDEX "tool_executions_tenant_id_created_at_idx" ON "tool_executions"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_intelligence_conversation_id_key" ON "conversation_intelligence"("conversation_id");
CREATE INDEX "conversation_intelligence_tenant_id_idx" ON "conversation_intelligence"("tenant_id");
CREATE INDEX "conversation_intelligence_tenant_id_detected_intent_idx" ON "conversation_intelligence"("tenant_id", "detected_intent");
CREATE INDEX "conversation_intelligence_tenant_id_sentiment_idx" ON "conversation_intelligence"("tenant_id", "sentiment");
CREATE INDEX "conversation_intelligence_tenant_id_analyzed_at_idx" ON "conversation_intelligence"("tenant_id", "analyzed_at");

-- AddForeignKey
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tool_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_intelligence" ADD CONSTRAINT "conversation_intelligence_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
