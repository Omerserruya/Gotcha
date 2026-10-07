-- The per-channel response mode was read by nothing at runtime: who answers
-- is decided by the playbook and automations (Conversation.handledBy), and
-- Copilot suggestions are decided per conversation. The route that wrote it
-- was removed in 8c204880 (Omer, 2026-10-07). Reverses 0022.

-- AlterTable
ALTER TABLE "channel_accounts" DROP COLUMN "response_mode";

-- DropEnum
DROP TYPE "ChannelResponseMode";
