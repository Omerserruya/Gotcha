-- Per-channel outbound answering mode.
--
-- VoiceOutboundMode controls how the platform initiates outbound calls.
--   IN_PLATFORM  - Agent's browser places the call (current behavior).
--   AGENT_FIRST  - Platform calls the default agent's mobile via Twilio
--                  REST first; once they answer, customer is bridged.
--                  Used by missed-call callback + WABA template flows
--                  so the agent doesn't need the browser open.
CREATE TYPE "VoiceOutboundMode" AS ENUM ('IN_PLATFORM', 'AGENT_FIRST');

ALTER TABLE "voice_channels"
  ADD COLUMN "outbound_mode" "VoiceOutboundMode" NOT NULL DEFAULT 'IN_PLATFORM';
