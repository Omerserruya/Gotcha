-- Voice channel: phone-number 1:N + auth_type (BYO / TWILIO_CONNECT).
-- Note: a different `AuthType` enum already exists for integration_catalog
-- (API_KEY / OAUTH2 / ...). To avoid the name collision we use a dedicated
-- `VoiceAuthType` enum for the voice-channel onboarding mode.

-- Drop legacy per-channel single phone number (replaced by voice_channel_phone_numbers below)
ALTER TABLE "voice_channels" DROP COLUMN IF EXISTS "phone_number";

-- Drop SHARED-vs-BYO connection mode (replaced by auth_type)
ALTER TABLE "communication_channels" DROP COLUMN IF EXISTS "connection_mode";
DROP TYPE IF EXISTS "ConnectionMode";

-- New auth type: how the tenant connected their Twilio account
CREATE TYPE "VoiceAuthType" AS ENUM ('BYO', 'TWILIO_CONNECT');
ALTER TABLE "communication_channels"
  ADD COLUMN "auth_type" "VoiceAuthType" NOT NULL DEFAULT 'BYO';

-- 1:N - phone numbers discovered from Twilio per voice channel
CREATE TABLE "voice_channel_phone_numbers" (
  "id"               TEXT NOT NULL,
  "voice_channel_id" TEXT NOT NULL,
  "e164"             TEXT NOT NULL,
  "twilio_sid"       TEXT,
  "friendly_name"    TEXT,
  "is_active"        BOOLEAN NOT NULL DEFAULT false,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_channel_phone_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voice_channel_phone_numbers_e164_key"
  ON "voice_channel_phone_numbers"("e164");
CREATE UNIQUE INDEX "voice_channel_phone_numbers_voice_channel_id_e164_key"
  ON "voice_channel_phone_numbers"("voice_channel_id", "e164");
CREATE INDEX "voice_channel_phone_numbers_voice_channel_id_idx"
  ON "voice_channel_phone_numbers"("voice_channel_id");
CREATE INDEX "voice_channel_phone_numbers_is_active_idx"
  ON "voice_channel_phone_numbers"("is_active");
ALTER TABLE "voice_channel_phone_numbers"
  ADD CONSTRAINT "voice_channel_phone_numbers_voice_channel_id_fkey"
  FOREIGN KEY ("voice_channel_id") REFERENCES "voice_channels"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
