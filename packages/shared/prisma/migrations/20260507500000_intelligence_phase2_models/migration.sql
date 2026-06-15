-- Migration: intelligence_phase2_models
-- Phase 2 of the conversation intelligence platform refactor.
-- Adds durable storage for the intelligence engine + post-call workflows.
-- No service code writes to these tables yet - Phase 3 starts using them.

-- ── 1. VoiceCallSession ────────────────────────────────────────
CREATE TABLE "voice_call_sessions" (
  "id"               TEXT NOT NULL,
  "call_sid"         TEXT NOT NULL,
  "conversation_id"  TEXT NOT NULL,
  "tenant_id"        TEXT NOT NULL,
  "agent_id"         TEXT,
  "customer_id"      TEXT,
  "customer_number"  TEXT NOT NULL,
  "agent_number"     TEXT,
  "direction"        TEXT NOT NULL,
  "status"           TEXT NOT NULL,
  "started_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answered_at"      TIMESTAMP(3),
  "ended_at"         TIMESTAMP(3),
  "duration_ms"      INTEGER,
  "recording_url"    TEXT,
  "recording_status" TEXT,
  "end_reason"       TEXT,
  "meta"             JSONB,
  CONSTRAINT "voice_call_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_call_sessions_call_sid_key" ON "voice_call_sessions" ("call_sid");
CREATE UNIQUE INDEX "voice_call_sessions_conversation_id_key" ON "voice_call_sessions" ("conversation_id");
CREATE INDEX "voice_call_sessions_tenant_id_started_at_idx" ON "voice_call_sessions" ("tenant_id", "started_at");
CREATE INDEX "voice_call_sessions_agent_id_started_at_idx" ON "voice_call_sessions" ("agent_id", "started_at");

ALTER TABLE "voice_call_sessions"
  ADD CONSTRAINT "voice_call_sessions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "voice_call_sessions"
  ADD CONSTRAINT "voice_call_sessions_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;

-- ── 2. CallAnalysis ────────────────────────────────────────────
CREATE TABLE "call_analyses" (
  "id"              TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "call_sid"        TEXT,
  "tenant_id"       TEXT NOT NULL,
  "mode"            TEXT NOT NULL,
  "status"          TEXT NOT NULL,
  "frames"          JSONB NOT NULL DEFAULT '[]'::jsonb,
  "rolling_summary" TEXT,
  "final_summary"   TEXT,
  "started_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"    TIMESTAMP(3),
  "meta"            JSONB,
  CONSTRAINT "call_analyses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_analyses_conversation_id_key" ON "call_analyses" ("conversation_id");
CREATE UNIQUE INDEX "call_analyses_call_sid_key" ON "call_analyses" ("call_sid");
CREATE INDEX "call_analyses_tenant_id_started_at_idx" ON "call_analyses" ("tenant_id", "started_at");
CREATE INDEX "call_analyses_conversation_id_idx" ON "call_analyses" ("conversation_id");

ALTER TABLE "call_analyses"
  ADD CONSTRAINT "call_analyses_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "call_analyses"
  ADD CONSTRAINT "call_analyses_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;

-- ── 3. CallPlaybook ────────────────────────────────────────────
CREATE TABLE "call_playbooks" (
  "id"          TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "active"      BOOLEAN NOT NULL DEFAULT TRUE,
  "version"     INTEGER NOT NULL DEFAULT 1,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "call_playbooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_playbooks_tenant_id_name_version_key" ON "call_playbooks" ("tenant_id", "name", "version");
CREATE INDEX "call_playbooks_tenant_id_active_idx" ON "call_playbooks" ("tenant_id", "active");

ALTER TABLE "call_playbooks"
  ADD CONSTRAINT "call_playbooks_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- ── 4. CallPlaybookStage ───────────────────────────────────────
CREATE TABLE "call_playbook_stages" (
  "id"              TEXT NOT NULL,
  "playbook_id"     TEXT NOT NULL,
  "ordinal"         INTEGER NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT NOT NULL,
  "exit_criteria"   TEXT NOT NULL,
  "required_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "prompts"         JSONB,
  CONSTRAINT "call_playbook_stages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_playbook_stages_playbook_id_ordinal_key" ON "call_playbook_stages" ("playbook_id", "ordinal");

ALTER TABLE "call_playbook_stages"
  ADD CONSTRAINT "call_playbook_stages_playbook_id_fkey"
  FOREIGN KEY ("playbook_id") REFERENCES "call_playbooks"("id") ON DELETE CASCADE;

-- ── 5. MissingFieldDefinition ──────────────────────────────────
CREATE TABLE "missing_field_definitions" (
  "id"                 TEXT NOT NULL,
  "tenant_id"          TEXT NOT NULL,
  "field"              TEXT NOT NULL,
  "label"              TEXT NOT NULL,
  "description"        TEXT,
  "required"           BOOLEAN NOT NULL DEFAULT TRUE,
  "applies_to_stages"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "hint_question"      TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "missing_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "missing_field_definitions_tenant_id_field_key" ON "missing_field_definitions" ("tenant_id", "field");

ALTER TABLE "missing_field_definitions"
  ADD CONSTRAINT "missing_field_definitions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- ── 6. ToolExecutionRequest ────────────────────────────────────
-- Distinct from the existing tool_executions log table. Captures the full
-- proposed → approved → running → completed/failed/denied lifecycle.
CREATE TABLE "tool_execution_requests" (
  "id"              TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "proposed_by"     JSONB NOT NULL,
  "actor"           JSONB NOT NULL,
  "tool"            TEXT NOT NULL,
  "args"            JSONB NOT NULL DEFAULT '{}'::jsonb,
  "rationale"       TEXT NOT NULL,
  "status"          TEXT NOT NULL,
  "result"          JSONB,
  "error"           TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "proposed_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at"      TIMESTAMP(3),
  "started_at"      TIMESTAMP(3),
  "completed_at"    TIMESTAMP(3),
  CONSTRAINT "tool_execution_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tool_execution_requests_conversation_id_proposed_at_idx" ON "tool_execution_requests" ("conversation_id", "proposed_at");
CREATE INDEX "tool_execution_requests_tenant_id_status_idx" ON "tool_execution_requests" ("tenant_id", "status");

ALTER TABLE "tool_execution_requests"
  ADD CONSTRAINT "tool_execution_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- ── 7. QAScore ─────────────────────────────────────────────────
CREATE TABLE "qa_scores" (
  "id"                        TEXT NOT NULL,
  "call_analysis_id"          TEXT NOT NULL,
  "conversation_id"           TEXT NOT NULL,
  "rubric_version"            TEXT NOT NULL,
  "playbook_compliance_score" DOUBLE PRECISION NOT NULL,
  "coaching_score"            DOUBLE PRECISION NOT NULL,
  "risk_score"                DOUBLE PRECISION NOT NULL,
  "findings"                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  "ref_live_frame_versions"   INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "scored_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qa_scores_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "qa_scores_conversation_id_idx" ON "qa_scores" ("conversation_id");
CREATE INDEX "qa_scores_scored_at_idx" ON "qa_scores" ("scored_at");

ALTER TABLE "qa_scores"
  ADD CONSTRAINT "qa_scores_call_analysis_id_fkey"
  FOREIGN KEY ("call_analysis_id") REFERENCES "call_analyses"("id") ON DELETE CASCADE;
