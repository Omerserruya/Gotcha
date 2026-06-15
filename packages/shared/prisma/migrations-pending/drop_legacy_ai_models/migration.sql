-- Attach voice channels to AIAgent (corrected direction).
--
-- DO NOT APPLY UNTIL THE GATE IN ./GATE.md IS MET.
--
-- This migration ADDS an `ai_agent_id` FK to `voice_channels` so the
-- same AI Employee that runs chat / copilot can also drive voice
-- call-pilot turns. The `copilot_config` JSONB column STAYS (no data
-- drop) - a follow-up migration retires it after the FK is observed
-- working for ≥ 1 week.

-- ─── 1. Add the FK column ──────────────────────────────────────
ALTER TABLE "voice_channels"
  ADD COLUMN "ai_agent_id" TEXT;

ALTER TABLE "voice_channels"
  ADD CONSTRAINT "voice_channels_ai_agent_id_fkey"
  FOREIGN KEY ("ai_agent_id") REFERENCES "ai_agents"("id")
  ON DELETE SET NULL;

CREATE INDEX "voice_channels_ai_agent_id_idx" ON "voice_channels"("ai_agent_id");

-- ─── 2. Optional auto-backfill ─────────────────────────────────
--
-- Link a voice channel to its tenant's sole active AIAgent when the
-- choice is unambiguous. Tenants with multiple agents are left for
-- the operator to resolve via the admin UI (the new "Voice channels
-- using this employee" section on the agent editor page).
--
-- This is intentionally conservative - we never auto-link when the
-- choice could be wrong.
WITH sole_active_agent AS (
  SELECT tenant_id, MIN(id) AS agent_id
  FROM "ai_agents"
  WHERE status = 'active'
  GROUP BY tenant_id
  HAVING COUNT(*) = 1
)
UPDATE "voice_channels" vc
SET "ai_agent_id" = saa.agent_id
FROM "channel_accounts" ca
JOIN sole_active_agent saa ON saa.tenant_id = ca.tenant_id
WHERE vc."communication_channel_id" = ca.id
  AND vc."ai_agent_id" IS NULL;

-- ─── 3. Folding copilot_config fields onto the agent ───────────
--
-- DEFERRED to application code (the cutover shim) rather than SQL.
-- Reason: the merge rules are non-trivial - we never want to overwrite
-- an existing agent persona/language with a channel's value. The shim's
-- `workerConfigFromAgent` already prefers agent fields; once every call
-- site uses the agent reference, the channel-level copilot_config is
-- ignored at runtime and can be dropped in a follow-up migration.
--
-- (No SQL update here - the data stays put.)

-- ─── 4. NOT IN SCOPE ───────────────────────────────────────────
--
-- AIAgent table          → retained, no changes (was previously
--                          drafted as DROP - that direction is reversed)
-- CallPlaybook tables    → handled by the playbook-fold codemod
--                          (services/ai/src/worker/pipeline/
--                          playbook-fold-codemod.ts) - separate effort
-- description columns    → retained on every table; the unified worker
--                          reads them via cutover-shim
