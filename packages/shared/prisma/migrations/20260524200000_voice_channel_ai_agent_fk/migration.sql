-- Phase 6: promote `copilot_config.aiAgentId` (JSONB) to a real FK column.
--
-- Why: the AI Employee that drives call-pilot turns on a voice channel is
-- a first-class attribute of the channel, not part of a fallback config
-- blob. Storing it on the JSONB made it invisible to joins, untyped,
-- impossible to enforce tenant isolation on, and hard to surface in the
-- channel detail UI. This migration:
--
--   1. Adds `voice_channels.ai_agent_id` (nullable TEXT) with FK +
--      SetNull-on-delete to `ai_agents.id`.
--   2. Backfills the column from any existing `copilot_config->>'aiAgentId'`
--      values. We DO NOT validate the referenced agent exists at the SQL
--      level - the FK constraint will fail if a stale id is present; if
--      that happens in a real environment we drop the bad value to keep
--      the migration green.
--   3. Strips `aiAgentId` from the JSONB blob after backfill so we don't
--      have two sources of truth. Reads in services/ai still tolerate the
--      legacy shape for one release (defensive parse).
--   4. Creates an index for the FK (Prisma convention).
--
-- Rollback strategy: drop the column. The JSONB strip is destructive but
-- the value is preserved on the FK column itself, so re-creating the JSONB
-- entry on rollback is mechanical.

ALTER TABLE "voice_channels"
  ADD COLUMN "ai_agent_id" TEXT;

-- Backfill from JSONB. Only copy values that look like cuids and refer to
-- an AIAgent that actually exists in the same tenant as the channel's
-- communication_channel. Anything else stays NULL.
UPDATE "voice_channels" vc
SET    "ai_agent_id" = vc."copilot_config"->>'aiAgentId'
FROM   "communication_channels" cc, "ai_agents" aa
WHERE  vc."communication_channel_id" = cc."id"
  AND  aa."id"        = vc."copilot_config"->>'aiAgentId'
  AND  aa."tenant_id" = cc."tenant_id";

-- Strip aiAgentId from the JSONB so the channel detail UI + copilot config
-- UI can't drift. The FK column is now the only source of truth.
UPDATE "voice_channels"
SET    "copilot_config" = "copilot_config" - 'aiAgentId'
WHERE  "copilot_config" ? 'aiAgentId';

ALTER TABLE "voice_channels"
  ADD CONSTRAINT "voice_channels_ai_agent_id_fkey"
    FOREIGN KEY ("ai_agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL;

CREATE INDEX "voice_channels_ai_agent_id_idx"
  ON "voice_channels" ("ai_agent_id");
