-- Persist the AI agent assigned to a conversation by the Main Playbook flow
-- (route_target → "agent"). Replaces RouterRule lookup as the source of truth
-- for "which AI agent handles this conversation" so resume is deterministic.
ALTER TABLE "conversations" ADD COLUMN "assigned_ai_agent_id" TEXT;

CREATE INDEX "conversations_tenant_id_assigned_ai_agent_id_idx"
  ON "conversations"("tenant_id", "assigned_ai_agent_id");
