-- The per-channel response mode was read by nothing at runtime: who answers
-- is decided by the playbook and automations (Conversation.handledBy), and
-- Copilot suggestions are decided per conversation. The route that wrote it
-- was removed in 8c204880 (Omer, 2026-10-07). Reverses 0022.
--
-- APPLY ONLY AFTER EVERY BACKEND IMAGE IS REBUILT with this schema: each image
-- bakes its own Prisma client, and an old client selects response_mode on any
-- channel account read without a select. Omer (2026-10-07): deferred to the
-- next full rebuild (e.g. the next release).

-- AlterTable
ALTER TABLE "channel_accounts" DROP COLUMN "response_mode";

-- DropEnum
DROP TYPE "ChannelResponseMode";
