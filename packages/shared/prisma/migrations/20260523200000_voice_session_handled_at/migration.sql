-- Server-side "missed call handled" marker.
--
-- Stamped when:
--   (a) the agent explicitly dismisses a missed-call row, or
--   (b) any outbound call to the same customerNumber reaches ACTIVE
--       (cascade in voice-session-store on the RINGING/CONNECTING →
--       ACTIVE transition).
--
-- The /missed query filters out `handled_at IS NOT NULL`. Without this
-- column, dismissals were per-agent localStorage - meaning the WhatsApp
-- template callback (browser-less) could never clear the inbox.
ALTER TABLE "voice_call_sessions"
  ADD COLUMN "handled_at" TIMESTAMP(3);
