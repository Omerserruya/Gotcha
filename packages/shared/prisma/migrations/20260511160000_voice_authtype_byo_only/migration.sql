-- Collapse VoiceAuthType to BYO-only.
--
-- Twilio OAuth Apps do not grant access to the customer's main-account phone
-- numbers (the OAuth handshake yields a Connect-scoped subaccount), so we are
-- abandoning that onboarding path entirely. Any rows currently flagged
-- `TWILIO_OAUTH` are dev-only failures: delete them, recreate the enum with
-- BYO as the sole value, and re-bind the column to the new enum.

DELETE FROM voice_channels WHERE communication_channel_id IN (SELECT id FROM communication_channels WHERE auth_type = 'TWILIO_OAUTH');
DELETE FROM communication_channels WHERE auth_type = 'TWILIO_OAUTH';
ALTER TYPE "VoiceAuthType" RENAME TO "VoiceAuthType_old";
CREATE TYPE "VoiceAuthType" AS ENUM ('BYO');
ALTER TABLE "communication_channels" ALTER COLUMN "auth_type" TYPE "VoiceAuthType" USING auth_type::text::"VoiceAuthType";
DROP TYPE "VoiceAuthType_old";
