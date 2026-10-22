-- AIAgent.channels ("Answers on") was display-only: who answers where is the
-- playbook (FlowCanvas), reported per channel by GET /api/ai-agents/:id/
-- reachability. The API stopped accepting and returning it in f79f1e6c,
-- after the redesign removed its UI.
--
-- APPLY ONLY AFTER EVERY BACKEND IMAGE IS REBUILT with this schema: each image
-- bakes its own Prisma client, and an old client selects channels on any
-- ai_agents read without a select. Goes with the deferred response_mode drop
-- (20261007120000) at the next full rebuild.

-- AlterTable
ALTER TABLE "ai_agents" DROP COLUMN "channels";
