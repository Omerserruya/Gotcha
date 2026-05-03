-- ─── System Agent Memory ────────────────────────────────────
-- Per-user, per-tenant rolling history for the System Copilot
-- (Command Center). Isolated from customer Conversation/Message tables to
-- keep operator threads from polluting customer-facing queries, audit, and
-- realtime publishers. Trimmed by the runtime to a rolling window.

CREATE TABLE "system_agent_messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_calls" JSONB,
    "tool_call_id" TEXT,
    "tool_name" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_agent_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "system_agent_messages_tenant_user_idx"
  ON "system_agent_messages" ("tenant_id", "user_id", "created_at" DESC);

CREATE INDEX "system_agent_messages_session_idx"
  ON "system_agent_messages" ("session_id", "created_at" ASC);

ALTER TABLE "system_agent_messages"
  ADD CONSTRAINT "system_agent_messages_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "system_agent_messages"
  ADD CONSTRAINT "system_agent_messages_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- ─── Approval requests: allow conversation-less plans ────────
-- System Copilot proposed plans (e.g. "build a workflow") aren't tied to
-- a customer conversation. Existing customer-bot approvals always set
-- this column, so the migration is non-destructive.
ALTER TABLE "approval_requests"
  ALTER COLUMN "conversation_id" DROP NOT NULL;
