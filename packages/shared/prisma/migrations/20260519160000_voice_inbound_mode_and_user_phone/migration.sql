-- Per-channel inbound answering mode + user mobile number for forward
-- and smart-callback flows.
--
-- VoiceInboundMode enum drives whether inbound calls go into the in-
-- platform copilot conference or are simply forwarded to the channel
-- default agent's personal phone via TwiML <Dial>.
--
-- `users.phone_number` stores the agent's E.164 mobile, used for the
-- forwarded ring AND for recognising the agent when they call the
-- business number back (smart-callback bridge to their last missed call).
CREATE TYPE "VoiceInboundMode" AS ENUM ('IN_PLATFORM', 'FORWARD_TO_AGENT');

ALTER TABLE "voice_channels"
  ADD COLUMN "inbound_mode" "VoiceInboundMode" NOT NULL DEFAULT 'IN_PLATFORM';

ALTER TABLE "users"
  ADD COLUMN "phone_number" TEXT;

CREATE INDEX "users_phone_number_idx" ON "users" ("phone_number");
