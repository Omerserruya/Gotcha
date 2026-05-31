-- Patch: schema declares AIAgent.goal and AIAgent.successCriteria but no
-- prior migration added them to the database. The generated Prisma client
-- selects both columns, so any findFirst()/findMany() on ai_agents crashes
-- with P2022 ("column does not exist") until they're present.
--
-- Idempotent (IF NOT EXISTS) so it's safe on environments where someone
-- already added the columns out-of-band with `prisma db push`.

ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "goal" TEXT;
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "success_criteria" TEXT;
