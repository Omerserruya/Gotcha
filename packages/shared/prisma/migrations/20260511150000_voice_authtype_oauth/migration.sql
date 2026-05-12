-- Rename Twilio Connect → Twilio OAuth Apps.
--
-- Connect issues a subaccount SID that doesn't expose the customer's main-
-- account phone numbers. OAuth Apps grants access to the customer's MAIN
-- account. This migration only renames the enum value — the column
-- (`communication_channels.auth_type`) and existing rows are preserved.

ALTER TYPE "VoiceAuthType" RENAME VALUE 'TWILIO_CONNECT' TO 'TWILIO_OAUTH';
