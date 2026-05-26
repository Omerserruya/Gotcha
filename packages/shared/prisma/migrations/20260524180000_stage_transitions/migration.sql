-- Pipeline stage transition audit log.
--
-- Captures every change to a customer's pipeline stage with its origin
-- (AUTO from the post-call summarizer, MANUAL from the live workspace,
-- REVIEW_TASK when confidence was below threshold and a CRM task was
-- created instead). Indexed for funnel velocity analytics and per-
-- conversation history scrubbing.

CREATE TABLE "stage_transitions" (
  "id"                  TEXT NOT NULL,
  "tenant_id"           TEXT NOT NULL,
  "conversation_id"     TEXT NOT NULL,
  "contact_id"          TEXT,
  "funnel_id"           TEXT NOT NULL,
  "from_stage_id"       TEXT,
  "from_stage_label"    TEXT,
  "to_stage_id"         TEXT NOT NULL,
  "to_stage_label"      TEXT,
  "source"              TEXT NOT NULL,
  "confidence"          DOUBLE PRECISION,
  "reason"              TEXT,
  "evidence"            JSONB NOT NULL DEFAULT '[]',
  "criteria_met"        JSONB NOT NULL DEFAULT '[]',
  "criteria_missed"     JSONB NOT NULL DEFAULT '[]',
  "vendor_value"        TEXT,
  "vendor_write_ok"     BOOLEAN NOT NULL DEFAULT false,
  "vendor_write_error"  TEXT,
  "actor_id"            TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stage_transitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stage_transitions_tenant_id_conversation_id_created_at_idx"
  ON "stage_transitions"("tenant_id", "conversation_id", "created_at");

CREATE INDEX "stage_transitions_tenant_id_contact_id_created_at_idx"
  ON "stage_transitions"("tenant_id", "contact_id", "created_at");

CREATE INDEX "stage_transitions_tenant_id_created_at_idx"
  ON "stage_transitions"("tenant_id", "created_at");
