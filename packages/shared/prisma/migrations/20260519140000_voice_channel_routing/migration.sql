-- Per-channel inbound routing: default agent + dept fallback + ring timeout.
-- `default_agent_id` is the first leg to ring; if unanswered after
-- `ring_timeout_seconds`, the call broadcasts to every member of
-- `fallback_department_id` (or, when null, to the whole tenant like today).
ALTER TABLE "voice_channels"
  ADD COLUMN "default_agent_id"       TEXT,
  ADD COLUMN "fallback_department_id" TEXT,
  ADD COLUMN "ring_timeout_seconds"   INTEGER NOT NULL DEFAULT 20;

ALTER TABLE "voice_channels"
  ADD CONSTRAINT "voice_channels_default_agent_id_fkey"
    FOREIGN KEY ("default_agent_id") REFERENCES "users"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "voice_channels_fallback_department_id_fkey"
    FOREIGN KEY ("fallback_department_id") REFERENCES "departments"("id") ON DELETE SET NULL;

CREATE INDEX "voice_channels_default_agent_id_idx"
  ON "voice_channels" ("default_agent_id");
CREATE INDEX "voice_channels_fallback_department_id_idx"
  ON "voice_channels" ("fallback_department_id");
