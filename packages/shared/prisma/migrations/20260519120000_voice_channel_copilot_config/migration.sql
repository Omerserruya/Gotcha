-- Per-channel Live Call Copilot config: language, persona, goals, required
-- questions, and data-collection fields. Json so shape can evolve without
-- migrations. Existing rows default to `{}` (= use platform defaults).
ALTER TABLE "voice_channels"
  ADD COLUMN "copilot_config" JSONB NOT NULL DEFAULT '{}'::jsonb;
