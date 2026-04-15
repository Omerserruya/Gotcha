/**
 * Unified tool gate — evaluates whether a tool invocation should be
 * allowed, denied, or routed through human approval.
 *
 * This is the single entry point that BOTH the bot engine (autonomous
 * actions mid-conversation) AND the action-executor (Command Center
 * plans) call before dispatching a tool. It replaces:
 *   - The hardcoded HIGH_RISK_TOOLS array in action-executor.service.ts
 *   - The ad-hoc policy checks scattered across the chatbot engine
 *
 * The decision chain:
 *   1. Load TenantToolPermission for (tenantId, toolName)
 *   2. If no row → apply system defaults (low-risk tools allow, known
 *      high-risk internal tools require approval)
 *   3. If row.enabled === false → DENY
 *   4. If row.requiresApproval === true → REQUIRE_APPROVAL
 *   5. Else → ALLOW
 *
 * Future: a second layer will run PolicyRule DSL conditions (F8 rule
 * engine) that can produce conditional REQUIRE_APPROVAL ("cancel_order
 * IF orderValue > 100"). That layer lives in services/ai/src/services/
 * policy.service.ts as evaluatePolicyRules() — this helper remains the
 * simple per-tool gate.
 *
 * See memory/bug_f4_approval_wrong_surface.md and
 * memory/gap_f2_tool_registry_missing_tools.md.
 */
import { prisma } from "./prisma";

export type ToolGateDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface ToolGateResult {
  decision: ToolGateDecision;
  reason: string;
  // Present when decision === REQUIRE_APPROVAL
  approvalConfig?: {
    approverRole: string | null;
    notifyChannels: string[];
    expiresAfterMin: number;
    allowModification: boolean;
  };
}

/**
 * Tools that default to REQUIRE_APPROVAL when no tenant permission row
 * exists. These are destructive, financial, or external-facing operations
 * where silent-allow would be a security problem.
 *
 * Tenants can override either direction by creating an explicit row.
 */
const INTERNAL_HIGH_RISK_DEFAULTS = new Set<string>([
  "send_message",
  "create_broadcast",
  "schedule_broadcast",
  "schedule_followup",
  "merge_contacts",
  "update_contact",
  "update_crm",
  "create_ticket",
  "create_task",
  "cancel_order",
  "issue_refund",
  "create_workflow",
]);

export async function evaluateToolGate(
  tenantId: string,
  toolName: string,
): Promise<ToolGateResult> {
  if (!toolName) {
    return { decision: "DENY", reason: "missing tool name" };
  }

  // Look up explicit per-tenant permission (unified table — covers both
  // internal registry tools and namespaced integration.* tools).
  const row = await (prisma as any).tenantToolPermission?.findUnique?.({
    where: { tenantId_toolName: { tenantId, toolName } },
  });

  if (row) {
    if (!row.enabled) {
      return {
        decision: "DENY",
        reason: `tool "${toolName}" is disabled for this tenant`,
      };
    }
    if (row.requiresApproval) {
      return {
        decision: "REQUIRE_APPROVAL",
        reason: `tool "${toolName}" requires human approval per tenant policy`,
        approvalConfig: {
          approverRole: row.approverRole ?? null,
          notifyChannels: Array.isArray(row.notifyChannels)
            ? (row.notifyChannels as string[])
            : ["in_app"],
          expiresAfterMin: row.expiresAfterMin ?? 30,
          allowModification: row.allowModification ?? false,
        },
      };
    }
    return { decision: "ALLOW", reason: "tenant permission explicit allow" };
  }

  // No explicit row — fall back to system defaults.
  if (INTERNAL_HIGH_RISK_DEFAULTS.has(toolName)) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `tool "${toolName}" is high-risk by default (no tenant override)`,
      approvalConfig: {
        approverRole: null,
        notifyChannels: ["in_app"],
        expiresAfterMin: 30,
        allowModification: false,
      },
    };
  }

  return { decision: "ALLOW", reason: "default allow for low-risk tool" };
}

/**
 * List all high-risk tool names that default to REQUIRE_APPROVAL. Used
 * by tenant-provisioning to seed TenantToolPermission rows with
 * appropriate defaults, and by the copilot UI to show which tools are
 * gated out of the box.
 */
export function getDefaultHighRiskTools(): string[] {
  return Array.from(INTERNAL_HIGH_RISK_DEFAULTS);
}
