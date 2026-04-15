-- F4 rebuild: bot-surface approval requests.
--
-- Created when an autonomous bot hits a tool marked
-- TenantToolPermission.requiresApproval=true. The conversation is paused
-- until a human in the inbox decides. See memory/bug_f4_approval_wrong_surface.md.
--
-- NOT used for Command Center — those actions are human-initiated by
-- construction and rely on dry-run preview + confirmation modal.

CREATE TYPE "ApprovalStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "approval_requests" (
    "id"                TEXT NOT NULL,
    "tenant_id"         TEXT NOT NULL,
    "conversation_id"   TEXT NOT NULL,
    "message_id"        TEXT,
    "contact_id"        TEXT,
    "tool"              TEXT NOT NULL,
    "params"            JSONB NOT NULL,
    "summary"           TEXT NOT NULL,
    "reason"            TEXT NOT NULL,
    "policy_rule_id"    TEXT,
    "policy_rule_name"  TEXT,
    "risk_level"        TEXT NOT NULL DEFAULT 'medium',
    "risk_tags"         JSONB NOT NULL DEFAULT '[]',
    "status"            "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by"      TEXT NOT NULL,
    "decided_by"        TEXT,
    "decided_at"        TIMESTAMP(3),
    "decision_reason"   TEXT,
    "modified_params"   JSONB,
    "expires_at"        TIMESTAMP(3) NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "approval_requests_tenant_id_status_idx"
    ON "approval_requests"("tenant_id", "status");
CREATE INDEX "approval_requests_tenant_id_conversation_id_idx"
    ON "approval_requests"("tenant_id", "conversation_id");
CREATE INDEX "approval_requests_tenant_id_contact_id_idx"
    ON "approval_requests"("tenant_id", "contact_id");
CREATE INDEX "approval_requests_expires_at_idx"
    ON "approval_requests"("expires_at");
