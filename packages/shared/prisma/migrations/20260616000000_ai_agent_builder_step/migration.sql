-- AI Employee creation wizard: resumable Draft progress.
--
-- `builder_step` tracks how far the creation wizard got: set to 'chat' when
-- the builder creates the DRAFT, advanced through chat→kb→refine→tools as the
-- admin proceeds, and cleared (NULL) once the agent is saved from the editor
-- (= wizard finished).
--
-- An INCOMPLETE wizard draft is `status = 'DRAFT' AND builder_step IS NOT NULL`:
-- those are surfaced as "resume setup" and excluded from the active employees
-- list, so abandoned sessions never pollute the account.
--
-- ADDITIVE, non-destructive. IF NOT EXISTS keeps it idempotent (the column was
-- hot-patched onto the dev DB via `db push` before this migration existed).

ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "builder_step" TEXT;
