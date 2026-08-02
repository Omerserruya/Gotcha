-- Standardize the default AI Employee chat model on gpt-5-mini.
-- The runtime resolves the model via env (OPENAI_DEFAULT_MODEL → getDefaultModel());
-- this aligns the per-agent column default and migrates existing agents that were
-- still on the previous default. Agents an operator explicitly set to another model
-- are left untouched (only rows equal to the old default 'gpt-4o-mini' flip).
ALTER TABLE "ai_agents" ALTER COLUMN "model" SET DEFAULT 'gpt-5-mini';

UPDATE "ai_agents" SET "model" = 'gpt-5-mini' WHERE "model" = 'gpt-4o-mini';
