-- Per-leg tracking for voice conferences. One row per participant ever
-- joined: the original customer, the answering agent, and any 3rd party
-- brought in via add-participant.
--
-- ADDED rows are inserted at dial-time (status=DIALING, callSid=null)
-- and updated to JOINED by the conference-status webhook matching on
-- `label` (Twilio echoes it back as ParticipantLabel). CUSTOMER + AGENT
-- rows are upserted at participant-join time keyed by callSid.
--
-- Drives the live "participants" panel (per-row hold/hangup) and lets
-- the post-call summarizer attribute the transcript to additional CRM
-- contacts when an added leg matched a known Contact by phone.
CREATE TYPE "VoiceParticipantRole" AS ENUM ('CUSTOMER', 'AGENT', 'ADDED');
CREATE TYPE "VoiceParticipantStatus" AS ENUM ('DIALING', 'JOINED', 'LEFT', 'FAILED');

CREATE TABLE "voice_session_participants" (
  "id"            TEXT                     NOT NULL,
  "session_id"    TEXT                     NOT NULL,
  "role"          "VoiceParticipantRole"   NOT NULL,
  "status"        "VoiceParticipantStatus" NOT NULL DEFAULT 'DIALING',
  "call_sid"      TEXT,
  "label"         TEXT,
  "phone_number"  TEXT,
  "display_name"  TEXT,
  "contact_id"    TEXT,
  "on_hold"       BOOLEAN                  NOT NULL DEFAULT FALSE,
  "joined_at"     TIMESTAMP(3),
  "left_at"       TIMESTAMP(3),
  "end_reason"    TEXT,
  "created_at"    TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3)             NOT NULL,

  CONSTRAINT "voice_session_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_session_participants_session_id_call_sid_key"
  ON "voice_session_participants" ("session_id", "call_sid");
CREATE UNIQUE INDEX "voice_session_participants_session_id_label_key"
  ON "voice_session_participants" ("session_id", "label");
CREATE INDEX "voice_session_participants_session_id_role_idx"
  ON "voice_session_participants" ("session_id", "role");
CREATE INDEX "voice_session_participants_session_id_left_at_idx"
  ON "voice_session_participants" ("session_id", "left_at");
CREATE INDEX "voice_session_participants_contact_id_idx"
  ON "voice_session_participants" ("contact_id");

ALTER TABLE "voice_session_participants"
  ADD CONSTRAINT "voice_session_participants_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "voice_call_sessions" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "voice_session_participants_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts" ("id") ON DELETE SET NULL;
