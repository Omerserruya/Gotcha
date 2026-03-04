-- CreateEnum
CREATE TYPE "ChannelResponseMode" AS ENUM ('HUMAN_WITH_COPILOT', 'AI_AUTO_REPLY');

-- AlterTable
ALTER TABLE "channel_accounts" ADD COLUMN "response_mode" "ChannelResponseMode" NOT NULL DEFAULT 'HUMAN_WITH_COPILOT';
