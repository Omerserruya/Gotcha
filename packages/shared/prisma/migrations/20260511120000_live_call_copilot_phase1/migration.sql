-- Live Call CoPilot - Phase 1 (additive only)
--
-- All changes are nullable / defaulted / new-table to guarantee zero impact
-- on existing rows or code paths. No backfills, no destructive operations.

-- ─── Enums ──────────────────────────────────────────────────────
CREATE TYPE "ConnectionMode" AS ENUM ('SHARED', 'BYO');
CREATE TYPE "CommunicationChannelStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'ERROR');
CREATE TYPE "CallState" AS ENUM ('RINGING', 'CONNECTING', 'ACTIVE', 'HOLD', 'ENDED', 'FAILED', 'MISSED');
CREATE TYPE "PresenceStatus" AS ENUM ('ONLINE', 'BUSY', 'OFFLINE');
CREATE TYPE "PostCallStage" AS ENUM ('PENDING', 'TRANSCRIPT_FINALIZED', 'SUMMARIZED', 'ACTION_ITEMS_EXTRACTED', 'CRM_WRITTEN', 'FOLLOWUP_GENERATED', 'FINALIZED', 'FAILED');
CREATE TYPE "ActionItemStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'DISMISSED', 'DONE');

-- ─── Tenant feature flags ───────────────────────────────────────
ALTER TABLE "tenants"
  ADD COLUMN "voice_copilot_enabled"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "voice_inbox_ui_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "voice_incoming_enabled" BOOLEAN NOT NULL DEFAULT false;

-- ─── VoiceCallSession additions ────────────────────────────────
ALTER TABLE "voice_call_sessions"
  ADD COLUMN "channel_id"         TEXT,
  ADD COLUMN "state"              "CallState",
  ADD COLUMN "state_history"      JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "assigned_agent_id"  TEXT,
  ADD COLUMN "claimed_at"         TIMESTAMP(3);

CREATE INDEX "voice_call_sessions_tenant_id_state_idx"       ON "voice_call_sessions"("tenant_id", "state");
CREATE INDEX "voice_call_sessions_assigned_agent_id_state_idx" ON "voice_call_sessions"("assigned_agent_id", "state");
CREATE INDEX "voice_call_sessions_channel_id_idx"            ON "voice_call_sessions"("channel_id");

-- ─── CommunicationChannel (polymorphic parent) ──────────────────
CREATE TABLE "communication_channels" (
  "id"                TEXT NOT NULL,
  "tenant_id"         TEXT NOT NULL,
  "channel_type"      "ChannelType" NOT NULL,
  "provider"          TEXT NOT NULL,
  "connection_mode"   "ConnectionMode" NOT NULL DEFAULT 'SHARED',
  "friendly_name"     TEXT NOT NULL,
  "status"            "CommunicationChannelStatus" NOT NULL DEFAULT 'PENDING',
  "capabilities"      JSONB NOT NULL DEFAULT '{}',
  "config"            JSONB NOT NULL DEFAULT '{}',
  "encrypted_secrets" BYTEA,
  "webhook_secret"    TEXT,
  "health_checked_at" TIMESTAMP(3),
  "health_status"     TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "communication_channels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "communication_channels_tenant_id_channel_type_status_idx" ON "communication_channels"("tenant_id", "channel_type", "status");

-- ─── VoiceChannel (specialization) ─────────────────────────────
CREATE TABLE "voice_channels" (
  "id"                       TEXT NOT NULL,
  "communication_channel_id" TEXT NOT NULL,
  "account_sid"              TEXT,
  "phone_number"             TEXT NOT NULL,
  "twiml_app_sid"            TEXT,
  "api_key_sid"              TEXT,
  CONSTRAINT "voice_channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voice_channels_communication_channel_id_key" ON "voice_channels"("communication_channel_id");

-- ─── AgentPresence ─────────────────────────────────────────────
CREATE TABLE "agent_presences" (
  "agent_id"                TEXT NOT NULL,
  "tenant_id"               TEXT NOT NULL,
  "status"                  "PresenceStatus" NOT NULL DEFAULT 'OFFLINE',
  "active_voice_session_id" TEXT,
  "last_seen_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_presences_pkey" PRIMARY KEY ("agent_id")
);
CREATE INDEX "agent_presences_tenant_id_status_idx" ON "agent_presences"("tenant_id", "status");
CREATE INDEX "agent_presences_last_seen_at_idx"     ON "agent_presences"("last_seen_at");

-- ─── VoiceCallPostProcessing ───────────────────────────────────
CREATE TABLE "voice_call_post_processing" (
  "id"          TEXT NOT NULL,
  "session_id"  TEXT NOT NULL,
  "stage"       "PostCallStage" NOT NULL DEFAULT 'PENDING',
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "last_error"  TEXT,
  "started_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "meta"        JSONB,
  CONSTRAINT "voice_call_post_processing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "voice_call_post_processing_session_id_key" ON "voice_call_post_processing"("session_id");
CREATE INDEX "voice_call_post_processing_stage_idx"            ON "voice_call_post_processing"("stage");

-- ─── VoiceCallActionItem ───────────────────────────────────────
CREATE TABLE "voice_call_action_items" (
  "id"          TEXT NOT NULL,
  "session_id"  TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "details"     TEXT,
  "status"      "ActionItemStatus" NOT NULL DEFAULT 'PROPOSED',
  "assigned_to" TEXT,
  "due_at"      TIMESTAMP(3),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_call_action_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "voice_call_action_items_session_id_idx" ON "voice_call_action_items"("session_id");
CREATE INDEX "voice_call_action_items_status_idx"     ON "voice_call_action_items"("status");

-- ─── Foreign keys ──────────────────────────────────────────────
ALTER TABLE "communication_channels"
  ADD CONSTRAINT "communication_channels_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voice_channels"
  ADD CONSTRAINT "voice_channels_communication_channel_id_fkey"
  FOREIGN KEY ("communication_channel_id") REFERENCES "communication_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_presences"
  ADD CONSTRAINT "agent_presences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voice_call_post_processing"
  ADD CONSTRAINT "voice_call_post_processing_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "voice_call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voice_call_action_items"
  ADD CONSTRAINT "voice_call_action_items_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "voice_call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voice_call_sessions"
  ADD CONSTRAINT "voice_call_sessions_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "communication_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
