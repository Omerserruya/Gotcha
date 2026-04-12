-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN "conversation_flow" JSONB,
ADD COLUMN "custom_guardrails" JSONB;
