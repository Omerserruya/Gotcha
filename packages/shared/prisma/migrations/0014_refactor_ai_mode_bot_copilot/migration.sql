-- Create BotType enum
CREATE TYPE "BotType" AS ENUM ('CHATBOT_FLOW', 'AUTONOMOUS_AI');

-- Add bot config to tenants (tenant-level)
ALTER TABLE "tenants" ADD COLUMN "bot_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "bot_type" "BotType";

-- Remove ai_mode from departments (copilot is always active, bot is tenant-level)
ALTER TABLE "departments" DROP COLUMN IF EXISTS "ai_mode";

-- Remove ai_mode from business_profiles
ALTER TABLE "business_profiles" DROP COLUMN IF EXISTS "ai_mode";

-- Drop the old AIMode enum (after columns are removed)
DROP TYPE IF EXISTS "AIMode";
