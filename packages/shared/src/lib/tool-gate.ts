/**
 * Unified tool policy gate — `evaluatePolicies()`.
 *
 * The single entry point every tool invocation flows through. Composes three
 * layers with STRICTEST-WINS semantics:
 *
 *   1. CatalogTool.hitlPolicy            — the floor, set by platform
 *   2. TenantTool.configOverrides.hitlPolicy — tenant may only tighten
 *   3. AgentToolPermission.requireApproval   — agent may only tighten
 *
 * For static tools (send_message, escalate_to_human, etc.) that have no
 * CatalogTool row, the floor comes from SYSTEM_TOOL_POLICIES below.
 *
 * Replaces:
 *   - INTERNAL_HIGH_RISK_DEFAULTS constant in this file (now inlined into SYSTEM_TOOL_POLICIES)
 *   - TenantToolPermission table as a primary source of truth (still read as
 *     a tenant-override fallback for static tools during transition)
 *   - Ad-hoc policy checks in action-executor / bot-engine
 *
 * `evaluateToolGate()` is kept as a thin back-compat shim. New call sites
 * should use `evaluatePolicies()`.
 */
import { prisma } from "./prisma";

// ─── Types ──────────────────────────────────────────────────

export type HitlMode = "never" | "always" | "on_condition";

export interface HitlPolicy {
  mode: HitlMode;
  condition?: string;
  approverRole?: string | null;
  notifyChannels?: string[];
  expiresAfterMin?: number;
  allowModification?: boolean;
}

export type ToolGateDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface PolicySnapshot {
  catalog?: HitlPolicy;
  tenant?: HitlPolicy;
  agent?: { requireApproval?: boolean; approverRole?: string | null };
}

export interface PolicyResult {
  decision: ToolGateDecision;
  reason: string;
  effective: HitlPolicy;
  snapshot: PolicySnapshot;
  approvalConfig?: {
    approverRole: string | null;
    notifyChannels: string[];
    expiresAfterMin: number;
    allowModification: boolean;
  };
}

// ─── Static tool policies ────────────────────────────────────
// Tools defined in the TOOL_REGISTRY (send_message, escalate_to_human, …) have
// no CatalogTool row. Their floor policy lives here. Tenants can still tighten
// via TenantToolPermission rows.

const SYSTEM_TOOL_POLICIES: Record<string, HitlPolicy> = {
  // Low-risk / context tools — always allowed.
  link_customer_identifier: { mode: "never" },
  escalate_to_human:        { mode: "never" },
  close_conversation:       { mode: "never" },
  interactive_reply:        { mode: "never" },
  tag_contact:              { mode: "never" },
  generate_followup:        { mode: "never" },

  // Write-side / external-facing — require approval by default.
  send_message:             { mode: "always" },
  create_broadcast:         { mode: "always" },
  schedule_broadcast:       { mode: "always" },
  schedule_followup:        { mode: "always" },
  merge_contacts:           { mode: "always" },
  update_contact:           { mode: "always" },
  update_crm:               { mode: "always" },
  create_ticket:            { mode: "always" },
  create_task:              { mode: "always" },
  cancel_order:             { mode: "always" },
  issue_refund:             { mode: "always" },
  create_workflow:          { mode: "always" },
};

// ─── Core evaluator ─────────────────────────────────────────

export async function evaluatePolicies(opts: {
  tenantId: string;
  toolName: string;
  aiAgentId?: string;
  args?: unknown;
}): Promise<PolicyResult> {
  if (!opts.toolName) {
    return denyResult("missing tool name", {});
  }

  const snapshot: PolicySnapshot = {};

  // Layer 1: catalog floor
  //   Integration tools → CatalogTool.hitlPolicy
  //   Static tools → SYSTEM_TOOL_POLICIES map
  let catalog: HitlPolicy;
  let tenantToolId: string | null = null;
  let tenantToolEnabled = true;

  if (opts.toolName.startsWith("integration_") || opts.toolName.includes(".")) {
    // Dynamic integration tool. Look it up via CatalogTool.
    const slug = opts.toolName.replace(/^integration[_.]/, "");
    const tenantTool = await (prisma as any).tenantTool?.findFirst?.({
      where: {
        tenantId: opts.tenantId,
        catalogTool: { slug },
      },
      include: { catalogTool: true },
    });

    if (!tenantTool) {
      return denyResult(`no tenant tool for slug "${slug}"`, {});
    }
    tenantToolId = tenantTool.id;
    tenantToolEnabled = tenantTool.isEnabled;

    catalog = (tenantTool.catalogTool?.hitlPolicy as HitlPolicy) ?? { mode: "never" };
  } else {
    // Static / system tool.
    catalog = SYSTEM_TOOL_POLICIES[opts.toolName] ?? { mode: "never" };
  }
  snapshot.catalog = catalog;

  // Layer 2: tenant override
  //   Integration tools → TenantTool.configOverrides.hitlPolicy
  //   Static tools → TenantToolPermission (legacy table, still read during
  //                   transition)
  let tenant: HitlPolicy | null = null;
  if (tenantToolId) {
    const overrides = await (prisma as any).tenantTool?.findUnique?.({
      where: { id: tenantToolId },
      select: { configOverrides: true, isEnabled: true },
    });
    tenantToolEnabled = overrides?.isEnabled ?? true;
    const overrideHitl = (overrides?.configOverrides as any)?.hitlPolicy as HitlPolicy | undefined;
    if (overrideHitl) tenant = overrideHitl;
  } else {
    // Static tool — legacy TenantToolPermission fallback
    const row = await (prisma as any).tenantToolPermission?.findUnique?.({
      where: { tenantId_toolName: { tenantId: opts.tenantId, toolName: opts.toolName } },
    }).catch(() => null);

    if (row) {
      if (!row.enabled) return denyResult(`tool "${opts.toolName}" disabled at tenant level`, { ...snapshot, tenant: { mode: "always" } });
      if (row.requiresApproval) {
        tenant = {
          mode: "always",
          approverRole: row.approverRole ?? null,
          notifyChannels: row.notifyChannels ?? ["in_app"],
          expiresAfterMin: row.expiresAfterMin ?? 30,
          allowModification: row.allowModification ?? false,
        };
      }
    }
  }
  if (tenant) snapshot.tenant = tenant;

  if (!tenantToolEnabled) {
    return denyResult(`tool "${opts.toolName}" disabled at tenant level`, snapshot);
  }

  // Layer 3: agent override (only applies to integration tools that have a
  // TenantTool). Static tools aren't per-agent-granted; they're available to
  // every agent by the existing TOOL_REGISTRY design.
  let agent: { requireApproval?: boolean; approverRole?: string | null } | undefined;
  if (opts.aiAgentId && tenantToolId) {
    const grant = await (prisma as any).agentToolPermission?.findFirst?.({
      where: { tenantId: opts.tenantId, aiAgentId: opts.aiAgentId, tenantToolId },
    });
    if (!grant || !grant.isAllowed) {
      return denyResult(`tool not granted to agent "${opts.aiAgentId}"`, snapshot);
    }
    if (grant.requireApproval) {
      agent = { requireApproval: true, approverRole: grant.approverRole ?? null };
      snapshot.agent = agent;
    }
  }

  // Compose strictest-wins
  const effective = composeStrictest(catalog, tenant, agent);

  // Materialise the decision
  if (effective.mode === "never") {
    return {
      decision: "ALLOW",
      reason: `policy allows (catalog=${catalog.mode}${tenant ? `, tenant=${tenant.mode}` : ""}${agent?.requireApproval ? ", agent=always" : ""})`,
      effective,
      snapshot,
    };
  }
  if (effective.mode === "always") {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `policy requires approval (catalog=${catalog.mode}${tenant ? `, tenant=${tenant.mode}` : ""}${agent?.requireApproval ? ", agent=always" : ""})`,
      effective,
      snapshot,
      approvalConfig: {
        approverRole: effective.approverRole ?? null,
        notifyChannels: effective.notifyChannels ?? ["in_app"],
        expiresAfterMin: effective.expiresAfterMin ?? 30,
        allowModification: effective.allowModification ?? false,
      },
    };
  }
  // on_condition — evaluate against args
  const hit = evaluateCondition(effective.condition, opts.args);
  if (hit) {
    return {
      decision: "REQUIRE_APPROVAL",
      reason: `condition matched: ${effective.condition}`,
      effective,
      snapshot,
      approvalConfig: {
        approverRole: effective.approverRole ?? null,
        notifyChannels: effective.notifyChannels ?? ["in_app"],
        expiresAfterMin: effective.expiresAfterMin ?? 30,
        allowModification: effective.allowModification ?? false,
      },
    };
  }
  return { decision: "ALLOW", reason: "condition not matched", effective, snapshot };
}

// ─── Composition: strictest wins ────────────────────────────

const MODE_RANK: Record<HitlMode, number> = { never: 0, on_condition: 1, always: 2 };

function composeStrictest(
  catalog: HitlPolicy,
  tenant: HitlPolicy | null,
  agent?: { requireApproval?: boolean; approverRole?: string | null },
): HitlPolicy {
  let mode: HitlMode = catalog.mode;
  let condition = catalog.condition;
  let approverRole = catalog.approverRole ?? null;
  const notifyChannels = catalog.notifyChannels ?? ["in_app"];
  const expiresAfterMin = catalog.expiresAfterMin ?? 30;
  const allowModification = catalog.allowModification ?? false;

  if (tenant) {
    if (MODE_RANK[tenant.mode] > MODE_RANK[mode]) {
      mode = tenant.mode;
      condition = tenant.condition ?? condition;
    }
    if (tenant.approverRole && !approverRole) approverRole = tenant.approverRole;
  }

  if (agent?.requireApproval && MODE_RANK.always > MODE_RANK[mode]) {
    mode = "always";
  }
  if (agent?.approverRole && !approverRole) {
    approverRole = agent.approverRole;
  }

  return { mode, condition, approverRole, notifyChannels, expiresAfterMin, allowModification };
}

// ─── Simple CEL-lite condition evaluator ────────────────────
// Supports: `args.amount > 100`, `args.currency == 'USD'`, `contains(args.tags, 'vip')`.
// Deliberately tiny — no external dependency. Expand later if needed.

function evaluateCondition(condition: string | undefined, args: unknown): boolean {
  if (!condition) return false;
  const expr = condition.trim();
  try {
    // Fallback: empty args → false for any condition that references args
    if (expr.includes("args.") && (!args || typeof args !== "object")) return false;

    // Narrow set of operators. No eval.
    const gtMatch  = expr.match(/^args\.(\w+)\s*(>|>=|<|<=|==|!=)\s*(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")$/);
    if (gtMatch) {
      const [, field, op, rawValue] = gtMatch;
      const actual = (args as Record<string, unknown>)[field];
      const expected = rawValue.startsWith("'") || rawValue.startsWith('"')
        ? rawValue.slice(1, -1)
        : Number(rawValue);
      const actualNum = Number(actual);
      const expectedNum = typeof expected === "number" ? expected : Number(expected);
      switch (op) {
        case ">":  return actualNum >   expectedNum;
        case ">=": return actualNum >=  expectedNum;
        case "<":  return actualNum <   expectedNum;
        case "<=": return actualNum <=  expectedNum;
        case "==": return actual === expected;
        case "!=": return actual !== expected;
      }
    }
    const containsMatch = expr.match(/^contains\(args\.(\w+),\s*'([^']*)'\)$/);
    if (containsMatch) {
      const [, field, value] = containsMatch;
      const actual = (args as Record<string, unknown>)[field];
      if (Array.isArray(actual)) return actual.includes(value);
      if (typeof actual === "string") return actual.includes(value);
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

// ─── Helpers ────────────────────────────────────────────────

function denyResult(reason: string, snapshot: PolicySnapshot): PolicyResult {
  return {
    decision: "DENY",
    reason,
    effective: { mode: "always" },
    snapshot,
  };
}

// ─── Back-compat shim ───────────────────────────────────────
// Legacy callers (action-executor, agent-tools.dispatchToolCall) use a
// simpler (tenantId, toolName) → ToolGateResult signature. This keeps them
// working until migrated to evaluatePolicies().

export interface ToolGateResult {
  decision: ToolGateDecision;
  reason: string;
  approvalConfig?: PolicyResult["approvalConfig"];
}

export async function evaluateToolGate(
  tenantId: string,
  toolName: string,
  aiAgentId?: string,
): Promise<ToolGateResult> {
  const r = await evaluatePolicies({ tenantId, toolName, aiAgentId });
  return { decision: r.decision, reason: r.reason, approvalConfig: r.approvalConfig };
}

/**
 * List all tool names that default to REQUIRE_APPROVAL (used by onboarding
 * to seed tenant tool permissions + admin UI "which tools are gated by default").
 */
export function getDefaultHighRiskTools(): string[] {
  return Object.entries(SYSTEM_TOOL_POLICIES)
    .filter(([, p]) => p.mode === "always")
    .map(([name]) => name);
}
