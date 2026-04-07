-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "shared_prompt" TEXT;
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "autonomous_prompt" TEXT;
