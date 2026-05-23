-- Separate agent target for AGENT_FIRST outbound.
--
-- Until now AGENT_FIRST routed to `default_agent_id` (the same field
-- used by inbound routing). That conflated two distinct decisions:
-- "who answers inbound" and "who rings on outbound". They can be the
-- same person, but the UI now lets you pick them independently.
--
-- Backward compat: null `agent_first_agent_id` falls back to
-- `default_agent_id` in the resolver, so existing channels keep
-- working without an explicit re-save.
ALTER TABLE "voice_channels"
  ADD COLUMN "agent_first_agent_id" TEXT;

ALTER TABLE "voice_channels"
  ADD CONSTRAINT "voice_channels_agent_first_agent_id_fkey"
    FOREIGN KEY ("agent_first_agent_id") REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX "voice_channels_agent_first_agent_id_idx"
  ON "voice_channels" ("agent_first_agent_id");
