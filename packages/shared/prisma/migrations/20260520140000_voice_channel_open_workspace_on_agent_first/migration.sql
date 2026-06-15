-- Per-channel toggle: when outbound is AGENT_FIRST, should the browser
-- open the workspace page? Default ON (preserves prior behavior).
-- OFF is for "fire and forget" outbound - agent clicks call, mobile
-- rings, no UI needed. Recording / transcription / summary still run.
ALTER TABLE "voice_channels"
  ADD COLUMN "open_workspace_on_agent_first" BOOLEAN NOT NULL DEFAULT TRUE;
