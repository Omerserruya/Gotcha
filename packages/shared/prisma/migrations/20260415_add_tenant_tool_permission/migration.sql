-- F2/F4/F8 convergence: unified per-tool gate for privacy + HITL approval.
--
-- One row per (tenant, toolName). Cross-cuts INTERNAL tools (static
-- TOOL_REGISTRY entries like "send_message", "cancel_order") AND EXTERNAL
-- integration tools (namespaced like "integration.hubspot.create_deal").
-- enabled=false → planner never sees the tool for this tenant.
-- requiresApproval=true → any action using this tool pauses the bot
-- conversation and creates an ApprovalRequest until a human decides.
--
-- Replaces the hardcoded HIGH_RISK_TOOLS list in
-- services/ai/src/services/action-executor.service.ts. Callers load this
-- row via the unified evaluatePolicies() entry point (to be added in a
-- subsequent task).
--
-- Default row policy: no row = "use system default" — internal low-risk
-- tools are enabled without approval; internal high-risk tools (refunds,
-- merges, broadcasts) get seeded with requiresApproval=true on tenant
-- provisioning.

CREATE TABLE "tenant_tool_permissions" (
    "id"                  TEXT NOT NULL,
    "tenant_id"           TEXT NOT NULL,
    "tool_name"           TEXT NOT NULL,
    "enabled"             BOOLEAN NOT NULL DEFAULT true,
    "requires_approval"   BOOLEAN NOT NULL DEFAULT false,
    "approver_role"       TEXT,
    "notify_channels"     JSONB NOT NULL DEFAULT '["in_app"]',
    "expires_after_min"   INTEGER NOT NULL DEFAULT 30,
    "allow_modification"  BOOLEAN NOT NULL DEFAULT false,
    "updated_by"          TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_tool_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_tool_permissions_tenant_id_tool_name_key"
    ON "tenant_tool_permissions"("tenant_id", "tool_name");
CREATE INDEX "tenant_tool_permissions_tenant_id_idx"
    ON "tenant_tool_permissions"("tenant_id");
CREATE INDEX "tenant_tool_permissions_tenant_id_enabled_idx"
    ON "tenant_tool_permissions"("tenant_id", "enabled");
