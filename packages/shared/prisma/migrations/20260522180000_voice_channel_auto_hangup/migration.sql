-- Opt-in hard cap on inbound ring duration. NULL = no auto-hangup
-- (existing behavior); when set, the inbound call is terminated and
-- the session marked MISSED after this many seconds.
ALTER TABLE "voice_channels"
  ADD COLUMN "auto_hangup_seconds" INTEGER;
