-- Spec violation removal: drop AIAgent.description.
--
-- The spec ("AI Worker Unification") removes the `description` field per
-- agent/config - agent identity is fully expressed through structured
-- fields (role, persona, tone, identity, behavioralAnchors, etc.) and the
-- free-text description was bypassing the structured-prompt contract.
--
-- Data preservation: this is destructive (text is gone). Operators who
-- want richer agent identity should move the content into
-- `behavioralAnchors` or `customGuardrails` BEFORE running this migration.
-- The codebase has stopped reading the column as of this release; the
-- column is dropped so Prisma/TS can't accidentally bring it back.

ALTER TABLE "ai_agents" DROP COLUMN IF EXISTS "description";
